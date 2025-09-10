// File: netlify/functions/submitTransaction.js (FINAL - USER-FRIENDLY ERRORS)

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
        return new Date();
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
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Required fields are missing." })};
        }
        
        const piServerTimeNow = await getPiServerTime();
        const targetUnlockTime = new Date(unlockTime);
        const msUntilUnlock = targetUnlockTime.getTime() - piServerTimeNow.getTime();

        // --- यह है सबसे बड़ा बदलाव ---
        // अब हम 500 एरर नहीं, बल्कि 400 का स्टेटस और एक मैसेज भेजेंगे
        if (msUntilUnlock > 7000) {
            const errorMessage = `It's too early. Pi server time is ${Math.round(msUntilUnlock / 1000)} seconds away. Try again closer to unlock time.`;
            return {
                statusCode: 400, // Bad Request - यह एक क्रैश नहीं है
                body: JSON.stringify({ success: false, error: errorMessage, code: 'TOO_EARLY' })
            };
        }
        // --- बदलाव खत्म ---

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
                
                if (result && result.hash) {
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
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
        // यह एक असली विफलता है, इसलिए हम 500 एरर भेजेंगे
        return { statusCode: 500, body: JSON.stringify({ success: false, error: detailedError })};

    } catch (err) {
        // यह एक अप्रत्याशित क्रैश है, इसलिए हम 500 एरर भेजेंगे
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
