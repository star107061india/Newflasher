// File: netlify/functions/getClaimableBalances.js (Final Version)

const { Keypair, Horizon } = require('stellar-sdk');
const { mnemonicToSeedSync } = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const axios = require('axios');

const server = new Horizon.Server("https://api.mainnet.minepi.com", {
    httpClient: axios.create({ timeout: 30000 }) // टाइमआउट 30 सेकंड कर दिया है
});

const createKeypairFromMnemonic = (mnemonic) => {
    try {
        return Keypair.fromRawEd25519Seed(derivePath("m/44'/314159'/0'", mnemonicToSeedSync(mnemonic).toString('hex')).key);
    } catch (e) {
        throw new Error("Invalid keyphrase. Please check for typos or extra spaces.");
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { mnemonic } = JSON.parse(event.body);
        if (!mnemonic) return { statusCode: 400, body: JSON.stringify({ success: false, error: "Keyphrase is required." }) };

        const keypair = createKeypairFromMnemonic(mnemonic);
        const response = await server.claimableBalances().claimant(keypair.publicKey()).limit(100).call();
        
        const balances = response.records.map(r => ({ id: r.id, amount: r.amount, asset: "PI" }));

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, balances, publicKey: keypair.publicKey() })
        };
    } catch (error) {
        // ▼▼▼ मजबूत एरर हैंडलिंग ▼▼▼
        console.error("Error in getClaimableBalances:", error);
        let detailedError = "An unknown error occurred.";
        if (error.message.includes("Invalid keyphrase")) {
            detailedError = error.message;
        } else if (error.response && error.response.status === 404) {
            detailedError = "This account was not found on the Pi network. Please ensure it is activated.";
        } else if (error.message.toLowerCase().includes('timeout')) {
            detailedError = "Request to Pi network timed out. The network may be busy. Please try again in a moment.";
        } else {
            detailedError = error.message;
        }
        return {
            statusCode: 200,
            body: JSON.stringify({ success: false, error: detailedError })
        };
    }
};
