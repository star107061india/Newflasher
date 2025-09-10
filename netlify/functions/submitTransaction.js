// =============================================================================
// FINAL & RELIABLE PI AUTO-TRANSFER BOT BACKEND
// Author: Gemini AI
// Version: 9.0 (The Persistent Worker)
// Description: This version REMOVES the racing logic entirely. Its only goal
// is to successfully submit the transaction by intelligently retrying until
// it succeeds or hits a hard limit. This is designed for reliability, not speed.
// =============================================================================

// --- 1. DEPENDENCIES ---
const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const axios = require('axios');

// --- 2. CONFIGURATION ---
const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
const MAX_ATTEMPTS = 15; // It will try a maximum of 15 times.
const RETRY_DELAY_MS = 1500; // Waits 1.5 seconds between each attempt.

// --- 3. HELPER FUNCTIONS ---
const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) {
        throw new Error("Invalid keyphrase provided.");
    }
};

// --- 4. MAIN SERVERLESS HANDLER ---
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
        const timebounds = { minTime: minTime, maxTime: minTime + 120 }; // Give it a 2-minute window to succeed.

        // --- THE PERSISTENT RETRY LOOP ---
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`--- Attempt #${attempt} of ${MAX_ATTEMPTS} ---`);
                
                // Load account INSIDE the loop to get the fresh sequence number every time.
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
                
                const totalOperations = parseInt(recordsPerAttempt, 10) * 2;
                let feePerOperation;
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
                    txBuilder
                        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                        .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));
                }

                const transaction = txBuilder.build();
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                // Submit and WAIT for the result.
                const result = await server.submitTransaction(transaction);
                
                // VICTORY!
                if (result && result.hash) {
                    console.log(`SUCCESS on attempt #${attempt}! Hash: ${result.hash}`);
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                
            } catch (error) {
                // --- INTELLIGENT ERROR HANDLING ---
                if (error.response?.status === 429) {
                    console.warn("Got 'Too Many Requests'. Waiting for 3 seconds before retrying.");
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait longer for rate limit
                    continue; // Skip the standard delay and retry
                }

                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq') {
                    console.warn("Bad sequence number. The bot will automatically fetch the new one and retry.");
                } else if (errorCode === 'tx_too_early') {
                    console.warn("It's still too early. Waiting a bit longer...");
                } else {
                    // For any other error, it's a real failure. Stop immediately.
                    console.error("A non-retriable error occurred:", error.response?.data || error.message);
                    const detailedError = `A permanent error occurred: ${errorCode || error.message}`;
                    return { statusCode: 400, body: JSON.stringify({ success: false, error: detailedError }) };
                }
            }
            // Wait before the next attempt.
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        
        // If the loop finishes after all attempts, it means we failed every time.
        const finalError = "Failed to submit transaction after all attempts. Please check the network or your account and try again.";
        return { statusCode: 500, body: JSON.stringify({ success: false, error: finalError }) };

    } catch (err) {
        console.error("A critical, unexpected error occurred:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred." }) };
    }
};
