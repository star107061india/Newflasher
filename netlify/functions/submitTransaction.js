// File: netlify/functions/submitTransaction.js (FINAL PREDICTIVE SUBMISSION LOGIC)

// --- ज़रूरी पैकेजेज़ इम्पोर्ट करें ---
const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

// --- Pi नेटवर्क से कनेक्शन सेट करें ---
const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Server(PI_HORIZON_URL);

// --- हेल्पर फंक्शन: Mnemonic से Keypair बनाने के लिए ---
const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(derived.key);
    } catch (e) {
        throw new Error("Invalid keyphrase. Please check for typos or extra spaces.");
    }
};

// --- मुख्य Netlify फंक्शन ---
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method Not Allowed' })};
    }

    try {
        // 1. फ्रंटएंड से सारी जानकारी निकालें
        const params = JSON.parse(event.body);
        const { senderMnemonic, sponsorMnemonic, claimableId, receiverAddress, amount, feeType, unlockTime } = params;

        if (!senderMnemonic || !claimableId) {
            throw new Error("Sender keyphrase and Claimable ID are required.");
        }

        // 2. Keypairs बनाएँ
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();

        // 3. TimeBounds (टाइम-लॉक) सेट करें
        let timebounds = null;
        if (unlockTime) {
            const minTime = Math.floor(Date.parse(unlockTime) / 1000); // Unix timestamp in seconds
            timebounds = {
                minTime: minTime,
                maxTime: minTime + 60 // ट्रांजैक्शन को 60 सेकंड बाद एक्सपायर कर दें
            };
        }

        // 4. रेस के लिए लूप सेट करें
        const RACE_DURATION_MS = 6000; // अब 6 सेकंड तक कोशिश करें (अनलॉक से पहले और बाद में)
        const ATTEMPT_DELAY_MS = 250;
        const startTime = Date.now();
        let lastError = null;

        while (Date.now() - startTime < RACE_DURATION_MS) {
            try {
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);

                // 5. ट्रांजैक्शन बनाएँ और उसमें TimeBounds जोड़ें
                const transaction = new StellarSdk.TransactionBuilder(accountToLoad, {
                    fee: (200).toString(), // फीस थोड़ी बढ़ा दें
                    networkPassphrase: PI_NETWORK_PASSPHRASE,
                    timebounds: timebounds // <<<--- YAHAN JADU HO RAHA HAI
                })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }))
                .setTimeout(30)
                .build();
                
                // 6. साइन करें
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                // 7. सबमिट करें
                const result = await server.submitTransaction(transaction);

                // 8. VICTORY!
                return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };

            } catch (error) {
                lastError = error;
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                
                // अब हम 'tx_too_early' एरर को भी हैंडल कर रहे हैं। यह सामान्य है।
                if (errorCode === 'tx_bad_seq' || errorCode === 'tx_too_early') {
                    console.log(`Expected race error: ${errorCode}. Retrying...`);
                } else {
                    console.warn("Attempt failed with other error:", error.message);
                }
            }
            await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
        }

        // 10. DEFEAT!
        let detailedError = "Failed: Bot was likely slower or a network issue occurred.";
        if (lastError) detailedError = lastError.message;
        throw new Error(detailedError);

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
    }
};
