// File: netlify/functions/submitTransaction.js (FIXED)

const { Keypair, Horizon, Operation, TransactionBuilder, Asset } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const axios = require('axios');

const server = new Horizon.Server("https://api.mainnet.minepi.com", {
    httpClient: axios.create({ timeout: 30000 })
});

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(derived.key);
    } catch (e) {
        throw new Error("Invalid keyphrase. Please check for typos or extra spaces.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method Not Allowed' })};

    try {
        const params = JSON.parse(event.body);
        
        const senderKeypair = createKeypairFromMnemonic(params.senderMnemonic);
        let sponsorKeypair = null;
        if (params.feeType === 'SPONSOR_PAYS' && params.sponsorMnemonic) {
            sponsorKeypair = createKeypairFromMnemonic(params.sponsorMnemonic);
        }

        const feeSourceKeypair = sponsorKeypair || senderKeypair;
        const accountToLoad = await server.loadAccount(feeSourceKeypair.publicKey());
        
        let recordsPerAttempt = parseInt(params.recordsPerAttempt, 10) || 1;
        if (recordsPerAttempt < 1) recordsPerAttempt = 1;

        // --- CORRECTED FEE LOGIC ---
        // The `fee` parameter for TransactionBuilder is the MAX FEE PER OPERATION.
        let feePerOperation;
        if (params.feeMechanism === 'CUSTOM' && params.customFee) {
            // If custom fee is provided, it's the TOTAL fee. We divide it by the number of operations.
            const totalOperations = 2 * recordsPerAttempt;
            feePerOperation = Math.ceil(parseInt(params.customFee, 10) / totalOperations).toString();
        } else {
            const baseFee = await server.fetchBaseFee();
            if (params.feeMechanism === 'SPEED_HIGH') {
                feePerOperation = (baseFee * 10).toString(); // 10x base fee PER OPERATION
            } else { // AUTOMATIC
                feePerOperation = baseFee.toString(); // Base fee PER OPERATION
            }
        }
        // --- END OF FEE LOGIC CORRECTION ---

        const txBuilder = new TransactionBuilder(accountToLoad, {
            fee: feePerOperation, // Use the corrected PER-OPERATION fee here
            networkPassphrase: "Pi Network",
        });
        
        for (let i = 0; i < recordsPerAttempt; i++) {
             txBuilder.addOperation(Operation.claimClaimableBalance({
                balanceId: params.claimableId,
                source: senderKeypair.publicKey()
            }));
            
            txBuilder.addOperation(Operation.payment({
                destination: params.receiverAddress,
                asset: Asset.native(),
                amount: params.amount.toString(),
                source: senderKeypair.publicKey()
            }));
        }

        const transaction = txBuilder.setTimeout(60).build();

        transaction.sign(senderKeypair);
        if (sponsorKeypair) {
            transaction.sign(sponsorKeypair);
        }
        
        const result = await server.submitTransaction(transaction);

        return { statusCode: 200, body: JSON.stringify({ success: true, response: result }) };

    } catch (error) {
        console.error("Error in submitTransaction:", error);
        let detailedError = "An unknown error occurred during transaction.";
        
        if (error.response?.data?.extras?.result_codes) {
            detailedError = `Pi Network Error: ${JSON.stringify(error.response.data.extras.result_codes)}`;
        } else if (error.response?.status === 404) {
            detailedError = "The sender or sponsor account was not found on the Pi network.";
        } else if (error.message.toLowerCase().includes('timeout')) {
            detailedError = "Request to Pi network timed out. The network may be busy.";
        } else {
            detailedError = error.message;
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: detailedError })
        };
    }
};
