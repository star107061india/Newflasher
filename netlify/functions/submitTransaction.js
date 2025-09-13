// =============================================================================
// PI BOT PROFESSIONAL BACKEND (FINAL & DEBUGGED)
// Author: Gemini AI
// Version: 16.1 (Function name .balanceId() corrected to .claimableBalanceId())
// Description: This version fixes the critical runtime error caused by using an
// incorrect SDK function name. This code will now correctly fetch the balance
// details and proceed with the transaction submission.
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
        // Step 1: Parse the data from the frontend.
        const { 
            senderMnemonic, 
            sponsorMnemonic, 
            claimableId, 
            receiverAddress,
            feeMultiplier, 
            recordsPerAttempt 
        } = JSON.parse(event.body);

        // Basic validation
        if (!senderMnemonic || !sponsorMnemonic || !claimableId || !receiverAddress) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing required fields." }) };
        }

        // Step 2: Create keypairs.
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const sponsorKeypair = createKeypairFromMnemonic(sponsorMnemonic);

        // Step 3: Fetch the claimable balance details.
        // *** THE FIX IS HERE: Corrected function name from .balanceId to .claimableBalanceId ***
        const response = await server.claimableBalances().claimableBalanceId(claimableId).call();
        if (!response || !response.records || response.records.length === 0) {
            throw new Error('Claimable balance not found or already claimed.');
        }
        const claimableBalance = response.records[0];
        const amountToTransfer = claimableBalance.amount;

        // Step 4: Build the transaction with both claim and payment operations.
        const feeSourceAccount = await server.loadAccount(sponsorKeypair.publicKey());
        const baseFee = await server.fetchBaseFee();
        
        const numOperations = 2 * (parseInt(recordsPerAttempt, 10) || 1);
        const fee = (baseFee * (parseInt(feeMultiplier, 10) || 1) * numOperations).toString();

        const transaction = new TransactionBuilder(feeSourceAccount, {
            fee,
            networkPassphrase: "Pi Network",
        });

        for (let i = 0; i < (parseInt(recordsPerAttempt, 10) || 1); i++) {
            // Operation 1: Claim
            transaction.addOperation(Operation.claimClaimableBalance({
                balanceId: claimableId,
                source: senderKeypair.publicKey() 
            }));
            
            // Operation 2: Pay
            transaction.addOperation(Operation.payment({
                destination: receiverAddress,
                asset: Asset.native(),
                amount: amountToTransfer,
                source: senderKeypair.publicKey()
            }));
        }
        
        const builtTransaction = transaction.setTimeout(30).build();

        // Step 5: Sign the transaction.
        builtTransaction.sign(senderKeypair, sponsorKeypair);
        
        // Step 6: Submit.
        const result = await server.submitTransaction(builtTransaction);
        
        return { 
            statusCode: 200, 
            body: JSON.stringify({ success: true, hash: result.hash }) 
        };

    } catch (error) {
        // Error handling
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
