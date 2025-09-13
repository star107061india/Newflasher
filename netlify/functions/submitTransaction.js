// =============================================================================
// PI BOT PROFESSIONAL BACKEND (REPAIRED)
// Author: Gemini AI
// Version: 15.1 (Corrected & Simplified)
// Description: This version is corrected to match the frontend. It only
// handles the 'claimClaimableBalance' operation, as claiming and paying
// in a single transaction is not possible. This fixes the 400 error.
// =============================================================================
const { Keypair, Horizon, TransactionBuilder, Operation } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

// Mainnet server
const server = new Horizon.Server("https://api.mainnet.minepi.com");

/**
 * Creates a Stellar Keypair from a BIP39 mnemonic phrase.
 * @param {string} mnemonic The mnemonic phrase.
 * @returns {Keypair} A Stellar Keypair object.
 */
const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) {
        // This will catch invalid mnemonic phrases.
        throw new Error("Invalid keyphrase provided.");
    }
};

// Main function for the Netlify serverless handler
exports.handler = async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    
    try {
        // Parse the data sent from the frontend
        const { 
            senderMnemonic, 
            sponsorMnemonic, 
            claimableId, 
            feeMultiplier, 
            recordsPerAttempt 
        } = JSON.parse(event.body);

        // --- VALIDATION ---
        if (!senderMnemonic || !sponsorMnemonic || !claimableId) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing required fields: senderMnemonic, sponsorMnemonic, or claimableId." }) };
        }

        // --- KEYPAIR CREATION ---
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);

        // --- TRANSACTION BUILDING ---
        // Load the sponsor's account to get the sequence number
        const feeSourceAccount = await server.loadAccount(sponsorKeypair.publicKey());
        
        // Fetch the base fee from the network
        const baseFee = await server.fetchBaseFee();
        
        // Calculate the total fee. Each claim is one operation.
        const numOperations = parseInt(recordsPerAttempt, 10) || 1;
        const fee = (baseFee * (parseInt(feeMultiplier, 10) || 1) * numOperations).toString();

        // Create the transaction builder, sponsored by the sponsor account
        const transaction = new TransactionBuilder(feeSourceAccount, {
            fee: fee,
            networkPassphrase: "Pi Network",
        });

        // Add the 'claimClaimableBalance' operation(s) to the transaction
        for (let i = 0; i < numOperations; i++) {
            transaction.addOperation(Operation.claimClaimableBalance({
                balanceId: claimableId,
                source: senderKeypair.publicKey() // The operation is performed BY the sender
            }));
        }
        
        // Build the transaction and set a 30-second timeout
        const builtTransaction = transaction.setTimeout(30).build();

        // --- SIGNING ---
        // The sender must sign because they are the source of the operation.
        // The sponsor must sign because they are the source of the transaction fee.
        builtTransaction.sign(senderKeypair, sponsorKeypair);
        
        // --- SUBMISSION ---
        const result = await server.submitTransaction(builtTransaction);
        
        // --- SUCCESS RESPONSE ---
        return { 
            statusCode: 200, 
            body: JSON.stringify({ success: true, hash: result.hash }) 
        };

    } catch (error) {
        // --- ERROR HANDLING ---
        let errorMessage = error.message;
        if (error.response && error.response.data && error.response.data.extras) {
            // Provide a more specific error from the Pi network if available
            errorMessage = error.response.data.extras.result_codes.transaction || error.response.data.extras.result_codes.operations.join(', ');
        }
        
        return { 
            statusCode: 400, 
            body: JSON.stringify({ success: false, error: errorMessage }) 
        };
    }
};
