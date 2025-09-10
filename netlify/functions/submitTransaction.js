// File: netlify/functions/submitTransaction.js (FINAL WITH CLOCK SYNC)

const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const https = require('https'); // We need this for the time sync HEAD request

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

// --- HELPER FUNCTIONS ---
const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(derived.key);
    } catch (e) {
        throw new Error("Invalid keyphrase.");
    }
};

// --- CLOCK SYNCHRONIZATION FUNCTION ---
const getPiServerTime = () => new Promise((resolve, reject) => {
    const options = { method: 'HEAD', host: 'api.mainnet.minepi.com', port: 443, path: '/' };
    const req = https.request(options, (res) => {
        if (res.headers.date) {
            resolve(new Date(res.headers.date));
        } else {
            reject(new Error("Could not get date header from Pi server."));
        }
    });
    req.on('error', reject);
    req.end();
});
// --- END OF HELPER FUNCTIONS ---


exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method Not Allowed' })};
    }

    try {
        const params = JSON.parse(event.body);
        const { senderMnemonic, sponsorMnemonic, claimableId, receiverAddress, amount, feeType, feeMechanism, customFee, recordsPerAttempt = 1, unlockTime } = params;

        if (!senderMnemonic || !claimableId || !unlockTime) {
            throw new Error("Required fields: sender keyphrase, claimable ID, and unlock time.");
        }

        // --- PRE-RACE PREPARATION ---
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();
        
        // --- CLOCK SYNC & RACE SCHEDULING ---
        console.log("Syncing clock with Pi Server...");
        const piServerTimeNow = await getPiServerTime();
        const targetUnlockTime = new Date(unlockTime);
        const msUntilUnlock = targetUnlockTime.getTime() - piServerTimeNow.getTime();

        console.log(`Pi Server time is: ${piServerTimeNow.toISOString()}`);
        console.log(`Target unlock time is: ${targetUnlockTime.toISOString()}`);
        console.log(`Milliseconds until unlock: ${msUntilUnlock}`);
        
        // Wait until it's almost time to start the race (e.g., 3 seconds before unlock)
        const raceStartWindowMs = 3000;
        if (msUntilUnlock > raceStartWindowMs) {
            const waitMs = msUntilUnlock - raceStartWindowMs;
            console.log(`Waiting for ${waitMs}ms before starting the race...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        
        // --- THE RACE BEGINS ---
        console.log("Race started! Submitting transactions...");
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 60 };

        const RACE_DURATION_MS = 6000; // Race for 6 seconds around the unlock time
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

                // VICTORY!
                console.log("SUCCESS! Transaction submitted and accepted by Horizon:", result.hash);
                return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };

            } catch (error) {
                lastError = error;
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq' || errorCode === 'tx_too_early') {
                    // These are expected errors during the race, do nothing
                } else {
                    console.warn("Attempt failed with unexpected error:", error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
        }

        // DEFEAT
        let detailedError = "Race finished. Transaction was likely not fast enough.";
        if (lastError?.response?.data?.extras?.result_codes) {
            detailedError = `Pi Network Error: ${JSON.stringify(lastError.response.data.extras.result_codes)}`;
        } else if (lastError) {
            detailedError = lastError.message;
        }
        throw new Error(detailedError);

    } catch (err) {
        console.error("Handler failed with error:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
