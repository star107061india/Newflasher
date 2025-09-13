// =============================================================================
// PI BOT PROFESSIONAL BACKEND (ADVANCED & CORRECTED)
// Author: Gemini AI
// Version: 16.0 (Claim & Transfer Logic Fixed)
// Description: This version correctly handles both claiming a balance and
// transferring the funds in a single atomic transaction. It intelligently
// fetches the claimable balance amount itself instead of relying on the frontend,
// fixing the 400 error and aligning with the user's requirement.
// =============================================================================
const { Keypair, Horizon, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

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
        throw new Error("Invalid keyphrase provided.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    
    try {
        // Step 1: Parse the data that the frontend is ACTUALLY sending.
        const { 
            senderMnemonic, 
            sponsorMnemonic, 
            claimableId, 
            receiverAddress, // We now use this address
            feeMultiplier, 
            recordsPerAttempt 
        } = JSON.parse(event.body);

        // Basic validation
        if (!senderMnemonic || !sponsorMnemonic || !claimableId || !receiverAddress) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing required fields." }) };
        }

        // Step 2: Create keypairs for the sender and sponsor
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);

        // Step 3: Fetch the details of the specific claimable balance to get the EXACT amount.
        // This is the key fix: we don't need the frontend to send the amount anymore.
        const response = await server.claimableBalances().balanceId(claimableId).call();
        if (!response || !response.records || response.records.length === 0) {
            throw new Error('Claimable balance not found or already claimed.');
        }
        const claimableBalance = response.records[0];
        const amountToTransfer = claimableBalance.amount;

        // Step 4: Build the transaction with BOTH operations.
        const feeSourceAccount = await server.loadAccount(sponsorKeypair.publicKey());
        const baseFee = await server.fetchBaseFee();
        
        // A claim + a payment = 2 operations.
        const numOperations = 2 * (parseInt(recordsPerAttempt, 10) || 1); 
        const fee = (baseFee * (parseInt(feeMultiplier, 10) || 1) * numOperations).toString();

        const transaction = new TransactionBuilder(feeSourceAccount, {
            fee,
            networkPassphrase: "Pi Network",
        });

        for (let i = 0; i < (parseInt(recordsPerAttempt, 10) || 1); i++) {
            // Operation 1: Claim the balance. The funds go to the sender's account.
            transaction.addOperation(Operation.claimClaimableBalance({
                balanceId: claimableId,
                source: senderKeypair.publicKey() 
            }));
            
            // Operation 2: Immediately send the funds from the sender's account to the receiver.
            transaction.addOperation(Operation.payment({
                destination: receiverAddress,
                asset: Asset.native(), // This means Pi
                amount: amountToTransfer,
                source: senderKeypair.publicKey()
            }));
        }
        
        const builtTransaction = transaction.setTimeout(30).build();

        // Step 5: Sign the transaction with BOTH keys.
        // Sender signs because they are performing the operations.
        // Sponsor signs because they are paying the fee.
        builtTransaction.sign(senderKeypair, sponsorKeypair);
        
        // Step 6: Submit the transaction.
        const result = await server.submitTransaction(builtTransaction);
        
        return { 
            statusCode: 200, 
            body: JSON.stringify({ success: true, hash: result.hash }) 
        };

    } catch (error) {
        // Improved error handling
        let errorMessage = error.message;
        if (error.response && error.response.data && error.response.data.extras) {
            const txError = error.response.data.extras.result_codes.transaction;
            const opErrors = error.response.data.extras.result_codes.operations;
            errorMessage = `Transaction Error: ${txError}. Operation Errors: ${opErrors ? opErrors.join(', ') : 'none'}`;
        }
        
        return { 
            statusCode: 400, 
            body: JSON.stringify({ success: false, error: errorMessage }) 
        };
    }
};
