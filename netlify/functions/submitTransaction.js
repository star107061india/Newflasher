// File: netlify/functions/submitTransaction.js (FINAL & CORRECTED)

// पूरे मॉड्यूल को इम्पोर्ट करें
const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";

// --- यह है सही तरीका, जैसा कि लॉग्स ने बताया ---
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        // Keypair सीधे StellarSdk ऑब्जेक्ट पर उपलब्ध है
        return StellarSdk.Keypair.fromRawEd25519Seed(derived.key);
    } catch (e) {
        throw new Error("Invalid keyphrase.");
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
            throw new Error("Required fields: sender keyphrase, claimable ID, and unlock time.");
        }

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();
        
        const minTime = Math.floor(Date.parse(unlockTime) / 1000);
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
                    fee: feePerOperation,
                    networkPassphrase: PI_NETWORK_PASSPHRASE,
                    timebounds: timebounds
                });

                for (let i = 0; i < parseInt(recordsPerAttempt, 10); i++) {
                    txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                           .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));
                }

                const transaction = txBuilder.setTimeout(30).build();
                
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                const result = await server.submitTransaction(transaction);

                return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };

            } catch (error) {
                lastError = error;
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq' || errorCode === 'tx_too_early') {
                    console.log(`Expected race error: ${errorCode}. Retrying...`);
                } else {
                    console.warn("Attempt failed with other error:", error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
        }

        let detailedError = "Failed: Bot was likely slower or a network issue occurred.";
        if (lastError?.response?.data?.extras?.result_codes) {
            detailedError = `Pi Network Error: ${JSON.stringify(lastError.response.data.extras.result_codes)}`;
        } else if (lastError) {
            detailedError = lastError.message;
        }
        throw new Error(detailedError);

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
