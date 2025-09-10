// =============================================================================
// FINAL & ROBUST PI BOT BACKEND
// Author: Gemini AI
// Version: 13.0 (The Resilient Worker)
// Description: This version has TRUE auto-retry. It handles not just
// 'tx_bad_seq' but also network timeouts and other temporary issues,
// making it far more reliable. It will not give up easily.
// =============================================================================

const { Keypair, Horizon, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const server = new Horizon.Server("https://api.mainnet.minepi.com");
const MAX_ATTEMPTS = 30; // Increased attempts for more reliability
const RETRY_DELAY_MS = 1500; // 1.5 second delay

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) {
        throw new Error("Invalid keyphrase provided.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const params = JSON.parse(event.body);
        const { senderMnemonic, claimableId, receiverAddress, amount, customFee, unlockTime, earlyCallTime = 0 } = params;

        if (!senderMnemonic || !claimableId || !unlockTime) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Required fields are missing." }) };
        }

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        
        const targetUnlockTime = new Date(unlockTime);
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 300 };

        const actualStartTime = targetUnlockTime.getTime() - parseInt(earlyCallTime, 10);
        const waitMs = actualStartTime - Date.now();

        if (waitMs > 0) {
            console.log(`Waiting for ${waitMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        console.log("Attack time reached! Starting persistent submission attempts...");

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`--- Attempt #${attempt} of ${MAX_ATTEMPTS} ---`);
                const accountToLoad = await server.loadAccount(senderKeypair.publicKey());
                
                const feePerOperation = Math.ceil(parseInt(customFee, 10) / 2).toString();

                const transaction = new TransactionBuilder(accountToLoad, {
                    fee: feePerOperation,
                    networkPassphrase: "Pi Network",
                    timebounds: timebounds
                })
                .addOperation(Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                .addOperation(Operation.payment({ destination: receiverAddress, asset: Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }))
                .build();

                transaction.sign(senderKeypair);
                
                const result = await server.submitTransaction(transaction);
                
                if (result && result.hash) {
                    console.log(`SUCCESS on attempt #${attempt}! Hash: ${result.hash}`);
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                
            } catch (error) {
                // --- THIS IS THE NEW, ROBUST RETRY LOGIC ---
                console.error(`Attempt #${attempt} failed. Analyzing error...`);
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                const retriableErrors = ['tx_bad_seq', 'tx_too_early'];

                // If it's a known retriable error OR a general network error (no response), we continue.
                if (retriableErrors.includes(errorCode) || !error.response) {
                    console.warn(`Error is retriable (${errorCode || 'Network Error'}). Continuing to next attempt...`);
                    // Fall through to the delay at the end of the loop
                } else {
                    // It's a permanent error. Give up.
                    const detailedError = `A permanent error occurred: ${errorCode || error.message}`;
                    console.error("Permanent error detected. Aborting.", error.response?.data || error);
                    return { statusCode: 400, body: JSON.stringify({ success: false, error: detailedError }) };
                }
            }
            // Wait before the next attempt
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        
        const finalError = "Failed to submit transaction after all attempts. The network might be too congested or a permanent issue exists with the account.";
        return { statusCode: 500, body: JSON.stringify({ success: false, error: finalError }) };

    } catch (err) {
        console.error("A critical, unexpected error occurred in the handler:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred. Check the logs." }) };
    }
};
