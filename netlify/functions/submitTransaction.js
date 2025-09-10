// =============================================================================
// FINAL & ULTIMATE PI BOT BACKEND
// Author: Gemini AI
// Version: 11.0 (The Ultimate Bot)
// Description: This bot combines the best strategies:
// 1. Early Call Time: For precision timing, just like the competitor.
// 2. Persistent Retries: It doesn't give up. It retries intelligently until success.
// 3. Reliability: This is designed to WORK, not just to race.
// =============================================================================

const StellarSdk = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const axios = require('axios');

const PI_NETWORK_PASSPHRASE = "Pi Network";
const PI_HORIZON_URL = "https://api.mainnet.minepi.com";
const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
const MAX_ATTEMPTS = 20; // It will try a maximum of 20 times after the start time.
const RETRY_DELAY_MS = 1000; // Waits 1 second between each attempt.

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
        const { senderMnemonic, claimableId, receiverAddress, amount, feeMechanism, customFee, unlockTime, earlyCallTime = 0 } = params;

        if (!senderMnemonic || !claimableId || !unlockTime) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Required fields are missing." }) };
        }

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const feeSourceAccountPublicKey = senderKeypair.publicKey();
        
        const targetUnlockTime = new Date(unlockTime);
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 300 }; // 5 minute validity window

        // --- THE "EARLY CALL" PRECISION TIMING LOGIC ---
        const actualStartTime = targetUnlockTime.getTime() - parseInt(earlyCallTime, 10);
        const waitMs = actualStartTime - Date.now();

        if (waitMs > 0) {
            console.log(`Waiting for ${waitMs}ms to reach the early call time...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        console.log("Attack time reached! Starting persistent submission attempts...");
        // --- END OF TIMING LOGIC ---

        // --- THE PERSISTENT RETRY LOOP ---
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`--- Attempt #${attempt} of ${MAX_ATTEMPTS} ---`);
                
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
                
                let feePerOperation;
                if (feeMechanism === 'CUSTOM' && customFee) {
                    feePerOperation = Math.ceil(parseInt(customFee, 10) / 2).toString(); // Assuming 2 ops: claim + payment
                } else {
                    feePerOperation = (await server.fetchBaseFee()).toString();
                }

                const txBuilder = new StellarSdk.TransactionBuilder(accountToLoad, {
                    fee: feePerOperation, networkPassphrase: PI_NETWORK_PASSPHRASE, timebounds: timebounds
                });

                txBuilder
                    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                    .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));

                const transaction = txBuilder.build();
                transaction.sign(senderKeypair);
                
                const result = await server.submitTransaction(transaction);
                
                if (result && result.hash) {
                    console.log(`SUCCESS on attempt #${attempt}! Hash: ${result.hash}`);
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                
            } catch (error) {
                // Intelligent error handling
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq' || errorCode === 'tx_too_early') {
                    console.warn(`Attempt #${attempt} failed with a retriable error: ${errorCode}. Retrying...`);
                } else {
                    // For any other error, it's a real failure. Stop.
                    console.error("A non-retriable error occurred:", error.response?.data || error.message);
                    const detailedError = `A permanent error occurred: ${errorCode || error.message}`;
                    return { statusCode: 400, body: JSON.stringify({ success: false, error: detailedError }) };
                }
            }
            // Wait before the next attempt.
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        
        // If the loop finishes, we failed every time.
        const finalError = "Failed to submit transaction after all attempts. The network might be too congested or the unlock time has passed.";
        return { statusCode: 500, body: JSON.stringify({ success: false, error: finalError }) };

    } catch (err) {
        console.error("A critical, unexpected error occurred:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred." }) };
    }
};
