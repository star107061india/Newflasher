// =============================================================================
// FINAL & ULTIMATE PI AUTO-TRANSFER BOT BACKEND
// Author: Gemini AI
// Version: 7.0 (Auto Fee-Bumping Edition)
// Description: This is the most aggressive strategy. The bot starts with a
// base fee and automatically increases it with every attempt within the race
// window, maximizing the chances of winning the fee war.
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

const getPiServerTime = async () => {
    try {
        const response = await axios.head(PI_HORIZON_URL, { timeout: 3000 });
        if (response.headers.date) return new Date(response.headers.date);
        return new Date();
    } catch (error) {
        console.warn(`Could not sync clock with Pi server, using local time.`);
        return new Date();
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

        if (feeMechanism !== 'CUSTOM') {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "This strategy requires 'Fee Mechanism' to be set to 'Custom'." }) };
        }
        
        const piServerTimeNow = await getPiServerTime();
        const targetUnlockTime = new Date(unlockTime);
        const msUntilUnlock = targetUnlockTime.getTime() - piServerTimeNow.getTime();

        if (msUntilUnlock > 7000) {
            const errorMessage = `It's too early. Pi server time is ${Math.round(msUntilUnlock / 1000)} seconds away.`;
            return { statusCode: 400, body: JSON.stringify({ success: false, error: errorMessage, code: 'TOO_EARLY' }) };
        }

        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        let sponsorKeypair = null;
        if (feeType === 'SPONSOR_PAYS' && sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);
        }
        const feeSourceAccountPublicKey = sponsorKeypair ? sponsorKeypair.publicKey() : senderKeypair.publicKey();
        
        const minTime = Math.floor(targetUnlockTime.getTime() / 1000);
        const timebounds = { minTime: minTime, maxTime: minTime + 60 };

        // --- THE AUTO FEE-BUMPING RACE ---
        // Get the account details ONCE before the race starts.
        const accountToLoad = await server.loadAccount(feeSourceAccountPublicKey);
        const totalOperations = parseInt(recordsPerAttempt, 10) * 2;
        let currentFee = parseInt(customFee, 10); // Start with the user's base fee.
        const feeIncrement = 10000; // Increase fee by 0.001 Pi on each attempt.

        const RACE_DURATION_MS = 6000;
        const ATTEMPT_DELAY_MS = 400; // A balanced delay
        const startTime = Date.now();
        let lastError = null;

        while (Date.now() - startTime < RACE_DURATION_MS) {
            try {
                // Calculate the fee for THIS specific attempt.
                const feeForThisAttempt = Math.ceil(currentFee / totalOperations).toString();
                
                const txBuilder = new StellarSdk.TransactionBuilder(accountToLoad, {
                    fee: feeForThisAttempt, networkPassphrase: PI_NETWORK_PASSPHRASE, timebounds: timebounds
                });

                for (let i = 0; i < parseInt(recordsPerAttempt, 10); i++) {
                    txBuilder
                        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId, source: senderKeypair.publicKey() }))
                        .addOperation(StellarSdk.Operation.payment({ destination: receiverAddress, asset: StellarSdk.Asset.native(), amount: amount.toString(), source: senderKeypair.publicKey() }));
                }

                const transaction = txBuilder.build();
                transaction.sign(senderKeypair);
                if (sponsorKeypair) transaction.sign(sponsorKeypair);
                
                // We don't wait for the result. We fire and forget to be as fast as possible.
                server.submitTransaction(transaction);
                
            } catch (error) {
                lastError = error;
            }
            // BUMP THE FEE for the next attempt.
            currentFee += feeIncrement;
            await new Promise(resolve => setTimeout(resolve, ATTEMPT_DELAY_MS));
        }
        
        // After the race, we can't be sure if we won or lost immediately.
        // We return a "success" message indicating the bot has finished its job.
        // The user must check their wallet to confirm victory.
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: `Race finished! The bot has submitted multiple transactions with increasing fees. Please check the receiver's wallet to confirm the result.`
            })
        };

    } catch (err) {
        console.error("A critical error occurred:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, error: "A critical server error occurred." }) };
    }
};
