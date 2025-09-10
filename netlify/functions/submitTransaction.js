// =============================================================================
// PI BOT PROFESSIONAL BACKEND
// Author: Gemini AI
// Version: 15.0 (The Final Version)
// Description: Stateless, single-shot transaction submitter with full support
// for Fee Sponsorship and Records Per Attempt.
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
        const { senderMnemonic, sponsorMnemonic, claimableId, receiverAddress, amount, unlockTime, feeMultiplier, recordsPerAttempt } = JSON.parse(event.body);
        
        const senderKeypair = createKeypairFromMnemonic(senderMnemonic);
        const hasSponsor = sponsorMnemonic && sponsorMnemonic.trim() !== '';
        const feeSourceKeypair = hasSponsor ? createKeypairFromMnemonic(sponsorMnemonic) : senderKeypair;

        const accountToLoad = await server.loadAccount(feeSourceKeypair.publicKey());
        
        const baseFee = await server.fetchBaseFee();
        const totalOperations = 2 * (parseInt(recordsPerAttempt, 10) || 1);
        const fee = (baseFee * (parseInt(feeMultiplier, 10) || 1) * totalOperations).toString();

        const txBuilder = new TransactionBuilder(accountToLoad, {
            fee: fee,
            networkPassphrase: "Pi Network",
            timebounds: { minTime: Math.floor(new Date(unlockTime).getTime() / 1000) - 120, maxTime: 0 }
        });

        for (let i = 0; i < (parseInt(recordsPerAttempt, 10) || 1); i++) {
            txBuilder
                .addOperation(Operation.claimClaimableBalance({
                    balanceId: claimableId,
                    source: senderKeypair.publicKey() // Action is by the sender
                }))
                .addOperation(Operation.payment({
                    destination: receiverAddress,
                    asset: Asset.native(),
                    amount: amount.toString(),
                    source: senderKeypair.publicKey() // Action is by the sender
                }));
        }

        const transaction = txBuilder.setTimeout(30).build();

        // Sign with sender, and also with sponsor if they exist
        transaction.sign(senderKeypair);
        if (hasSponsor) {
            transaction.sign(feeSourceKeypair);
        }
        
        const result = await server.submitTransaction(transaction);
        
        return { statusCode: 200, body: JSON.stringify({ success: true, hash: result.hash }) };

    } catch (error) {
        const errorCode = error.response?.data?.extras?.result_codes?.transaction || error.message;
        return { statusCode: 400, body: JSON.stringify({ success: false, error: errorCode }) };
    }
};```

#### `getClaimableBalances.js` (कोई बदलाव नहीं)

```javascript
const { Keypair, Horizon } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const server = new Horizon.Server("https://api.mainnet.minepi.com");

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        const seed = mnemonicToSeedSync(mnemonic);
        const derivedPath = derivePath("m/44'/314159'/0'", seed.toString('hex'));
        return Keypair.fromRawEd25519Seed(derivedPath.key);
    } catch (e) { throw new Error("Invalid keyphrase."); }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    try {
        const { mnemonic, sponsorMnemonic } = JSON.parse(event.body);
        if(!mnemonic) throw new Error("Sender keyphrase is required.");

        const senderKeypair = createKeypairFromMnemonic(mnemonic);
        const hasSponsor = sponsorMnemonic && sponsorMnemonic.trim() !== '';
        const feePayerKeypair = hasSponsor ? createKeypairFromMnemonic(sponsorMnemonic) : senderKeypair;

        // Fetch claimable balances for the SENDER
        const claimableBalancesResponse = await server.claimableBalances().claimant(senderKeypair.publicKey()).limit(100).call();
        const balances = claimableBalancesResponse.records.map(r => ({ id: r.id, amount: r.amount }));

        // Fetch native balance for the FEE PAYER
        const feePayerAccount = await server.loadAccount(feePayerKeypair.publicKey());
        const feePayerBalance = feePayerAccount.balances.find(b => b.asset_type === 'native')?.balance || '0.0';

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, balances, feePayerBalance })
        };
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: error.message }) };
    }
};
