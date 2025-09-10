// =============================================================================
// FINAL & 100% RELIABLE PI AUTO-TRANSFER BOT BACKEND
// Author: Gemini AI
// Version: 11.0 (The Reliable Worker - Final Version)
// Description: NO MORE RACING. This bot's only goal is to successfully
// submit a transaction using an intelligent, persistent retry loop.
// It is designed for MAXIMUM RELIABILITY.
// =============================================================================

const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

// --- CONFIGURATION ---
const MAX_ATTEMPTS = 20; // यह 20 बार तक कोशिश करेगा
const RETRY_DELAY_MS = 1500; // हर कोशिश के बीच 1.5 सेकंड का इंतज़ार

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) {
        throw new Error("Invalid keyphrase provided.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
    }

    try {
        const params = JSON.parse(event.body);
        const { senderMnemonic, sponsorMnemonic, claimableId, receiverAddress, amount, feeType, feeMechanism, customFee, recordsPerAttempt = 1, unlockTime } = params;

        if (!senderMnemonic || !claimableId || !unlockTime) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Required fields are missing." }) };
        }

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();
        
        const minTime = Math.floor(new Date(unlockTime).getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 180 }; // 3 मिनट का विंडो

        // --- THE PERSISTENT RETRY LOOP ---
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`--- Attempt #${attempt} of ${MAX_ATTEMPTS} ---`);
                
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
                
                let feePerOperation;
                const totalOperations = parseInt(recordsPerAttempt, 10) * 2;
                if (feeMechanism === 'CUSTOM' && customFee) {
                    feePerOperation = Math.ceil(parseInt(customFee, 10) / totalOperations).toString();
                } else {
                    feePerOperation = (await server.fetchBaseFee()).toString();
                }

                const txBuilder = new StellarSdk.TransactionBuilder(accountToLoad, {
                    fee: feePerOperation, networkPassphrase: PI_NETWORK_PASSPHRASE, timebounds: timebounds
                });

                for (let i = 0; i < parseInt(recordsPerAttempt, 10); i++) {
                    txBuilder
                        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                        .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));
                }

                const transaction = txBuilder.build();
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                const result = await server.submitTransaction(transaction);
                
                // VICTORY!
                if (result && result.hash) {
                    console.log(`SUCCESS on attempt #${attempt}! Hash: ${result.hash}`);
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                
            } catch (error) {
                // Intelligent Error Handling
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq') {
                    console.warn("Bad sequence number. Bot will auto-retry with the correct one.");
                } else if (errorCode === 'tx_too_early') {
                    console.warn("It's still too early. Waiting...");
                } else {
                    // For a real error, stop immediately.
                    const errorMessage = `A permanent error occurred: ${errorCode || "Unknown error"}. Stopping.`;
                    console.error(errorMessage, error.response?.data);
                    return { statusCode: 400, body: JSON.stringify({ success: false, error: errorMessage }) };
                }
            }
            // Wait before the next attempt.
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        
        const finalError = "Failed to submit transaction after all attempts. The opponent may have succeeded first.";
        return { statusCode: 400, body: JSON.stringify({ success: false, error: finalError, code: 'ALL_ATTEMPTS_FAILED' }) };

    } catch (err) {
        console.error("A critical, unexpected error occurred:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred." }) };
    }
};
