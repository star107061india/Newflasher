// File: netlify/functions/submitTransaction.js (FINAL WITH LAST-SECOND TIME CHECK)

const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const axios = require('axios');

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        return StellarSdk.Keypair.fromRawEd25519Seed(derivePath("m/44'/314159'/0'", seed.toString('hex')).key);
    } catch (e) { throw new Error("Invalid keyphrase."); }
};

const getPiServerTime = async () => {
    try {
        const response = await axios.head(PI_HORIZON_URL, { timeout: 3000 });
        if (response.headers.date) return new Date(response.headers.date);
        throw new Error("Date header not found.");
    } catch (error) {
        console.warn("Could not sync clock with Pi server, using local time.");
        return new Date(); // Fallback
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method Not Allowed' })};
    }

    try {
        const params = JSON.parse(event.body);
        const { senderMnemonic, sponsorMnemonic, claimableId, receiverAddress, amount, feeType, feeMechanism, customFee, recordsPerAttempt = 1, unlockTime } = params;

        if (!senderMnemonic || !claimableId || !unlockTime) {
            throw new Error("Required fields are missing.");
        }
        
        // --- LAST-SECOND TIME CHECK ---
        const piServerTimeNow = await getPiServerTime();
        const targetUnlockTime = new Date(unlockTime);
        const msUntilUnlock = targetUnlockTime.getTime() - piServerTimeNow.getTime();

        // If we are more than 7 seconds away according to Pi's clock, it's too early.
        if (msUntilUnlock > 7000) {
            throw new Error(`It's too early. Pi server time is ${Math.round(msUntilUnlock / 1000)} seconds away from unlock. Please try again closer to the unlock time.`);
        }
        // --- END OF TIME CHECK ---

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();
        
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 60 };

        const RACE_DURATION_MS = 6000;
        const ATTEMPT_DELAY_MS = 250;
        const startTime = Date.now();
        let lastError = null;

        while (Date.now() - startTime < RACE_DURATION_MS) {
            try {
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
                
                let feePerOperation;
                const totalOperations = parseInt(recordsPerAttempt, 10) * 2;
                if (feeMechanism === 'CUSTOM' && customFee) {
                    feePerOperation = Math.ceil(parseInt(customFee, 10) / totalOperations).toString();
                } else {
                    const baseFee = await server.fetchBaseFee();
                    feePerOperation = (feeMechanism === 'SPEED_HIGH') ? (baseFee * 10).toString() : baseFee.toString();
                }

                const txBuilder = new StellarSdk.TransactionBuilder(accountToLoad, {
                    fee: feePerOperation, networkPassphrase: PI_NETWORK_PASSPHRASE, timebounds: timebounds
                });

                for (let i = 0; i < parseInt(recordsPerAttempt, 10); i++) {
                    txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                           .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));
                }

                const transaction = txBuilder.build();
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                const result = await server.submitTransaction(transaction);
                
                // FINAL VICTORY CHECK
                if (result && result.hash) {
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                // This part should ideally not be reached as submitTransaction throws on failure
                throw new Error("Transaction was accepted but returned no hash.");

            } catch (error) {
                lastError = error;
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode !== 'tx_bad_seq' && errorCode !== 'tx_too_early') {
                    console.warn("Attempt failed with unexpected error:", error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
        }
        
        let detailedError = "Race finished. Transaction was likely not fast enough.";
        if (lastError?.response?.data?.extras?.result_codes?.transaction) {
            detailedError = `Last seen error: ${lastError.response.data.extras.result_codes.transaction}`;
        } else if (lastError) { detailedError = lastError.message; }
        throw new Error(detailedError);

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
