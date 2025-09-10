// =============================================================================
// FINAL & SIMPLIFIED PI BOT BACKEND
// Author: Gemini AI
// Version: 14.0 (Single-Shot Submitter)
// Description: This function is now stateless. It attempts to submit a
// transaction ONCE and returns the result. The retry logic is now correctly
// handled by the frontend to prevent 504 Gateway Timeouts.
// =============================================================================
const { Keypair, Horizon, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const server = new Horizon.Server("https://api.mainnet.minepi.com");

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) {
        throw new Error("Invalid keyphrase.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    try {
        const { senderMnemonic, claimableId, receiverAddress, amount, unlockTime, feeMultiplier } = JSON.parse(event.body);
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const accountToLoad = await server.loadAccount(senderKeypair.publicKey());
        
        const baseFee = await server.fetchBaseFee();
        const fee = (baseFee * (parseInt(feeMultiplier, 10) || 1)).toString();

        const transaction = new TransactionBuilder(accountToLoad, {
            fee: fee, // The total fee for the transaction
            networkPassphrase: "Pi Network",
            timebounds: { minTime: Math.floor(new Date(unlockTime).getTime() / 1000) - 60, maxTime: 0 }
        })
        .addOperation(Operation.claimClaimableBalance({ balanceId: claimableId }))
        .addOperation(Operation.payment({ destination: receiverAddress, asset: Asset.native(), amount: amount.toString() }))
        .setTimeout(30)
        .build();

        transaction.sign(senderKeypair);
        const result = await server.submitTransaction(transaction);
        
        return { statusCode: 200, body: JSON.stringify({ success: true, hash: result.hash }) };

    } catch (error) {
        const errorCode = error.response?.data?.extras?.result_codes?.transaction || error.message;
        return { statusCode: 400, body: JSON.stringify({ success: false, error: errorCode }) };
    }
};
