// =============================================================================
// FINAL & ULTIMATE PI BOT BACKEND
// Author: Gemini AI
// Version: 12.1 (Bug Fix: Removed Conflicting Timeout)
// Description: This version fixes the "TimeBounds.max_time" crash. The
// redundant .setTimeout(30) has been removed, making the transaction
// builder logic correct and stable.
// =============================================================================

const { Keypair, Horizon, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const server = new Horizon.Server("https://api.mainnet.minepi.com");
const MAX_ATTEMPTS = 25;
const RETRY_DELAY_MS = 1000;

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
        const feeSourceAccountPublicKey = senderKeypair.publicKey();
        
        const targetUnlockTime = new Date(unlockTime);
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 300 };

        const actualStartTime = targetUnlockTime.getTime() - parseInt(earlyCallTime, 10);
        const waitMs = actualStartTime - Date.now();

        if (waitMs > 0) {
            console.log(`Waiting for ${waitMs}ms to reach the early call time...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        console.log("Attack time reached! Starting persistent submission attempts...");

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`--- Attempt #${attempt} of ${MAX_ATTEMPTS} ---`);
                const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
                
                const feePerOperation = Math.ceil(parseInt(customFee, 10) / 2).toString();

                const transaction = new TransactionBuilder(accountToLoad, {
                    fee: feePerOperation,
                    networkPassphrase: "Pi Network",
                    timebounds: timebounds // <- हम सिर्फ इसका उपयोग करेंगे
                })
                .addOperation(Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                .addOperation(Operation.payment({ destination: receiverAddress, asset: Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }))
                // .setTimeout(30) // <- THIS CONFLICTING LINE HAS BEEN REMOVED
                .build();

                transaction.sign(senderKeypair);
                
                const result = await server.submitTransaction(transaction);
                
                if (result && result.hash) {
                    console.log(`SUCCESS on attempt #${attempt}! Hash: ${result.hash}`);
                    return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };
                }
                
            } catch (error) {
                const errorCode = error.response?.data?.extras?.result_codes?.transaction;
                if (errorCode === 'tx_bad_seq' || errorCode === 'tx_too_early') {
                    console.warn(`Attempt #${attempt} failed with a retriable error: ${errorCode}. Retrying...`);
                } else {
                    const detailedError = `A permanent error occurred: ${errorCode || error.message}`;
                    return { statusCode: 400, body: JSON.stringify({ success: false, error: detailedError }) };
                }
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        
        const finalError = "Failed to submit transaction after all attempts. The network might be too congested.";
        return { statusCode: 500, body: JSON.stringify({ success: false, error: finalError }) };

    } catch (err) {
        console.error("A critical, unexpected error occurred:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred." }) };
    }
};
