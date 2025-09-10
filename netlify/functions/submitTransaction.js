// File: netlify/functions/submitTransaction.js (DIAGNOSTIC CODE - ONLY FOR TESTING)

exports.handler = async (event) => {
    try {
        console.log("--- DIAGNOSTIC TEST STARTED ---");

        // stellar-sdk मॉड्यूल को लोड करने की कोशिश करें
        const StellarSdk = require('stellar-sdk');
        
        // Netlify को जो StellarSdk ऑब्जेक्ट मिल रहा है, उसे लॉग करें
        console.log("--- Structure of StellarSdk Module ---");
        console.log(StellarSdk);
        
        // उस ऑब्जेक्ट के अंदर क्या-क्या है (keys), उसे भी लॉग करें
        console.log("--- Keys available on StellarSdk object ---");
        console.log(Object.keys(StellarSdk));

        // जाँच करें कि 'Server' या 'Horizon' मौजूद है या नहीं
        if (StellarSdk.Server) {
            console.log("DIAGNOSTIC RESULT: 'StellarSdk.Server' was found!");
        } else if (StellarSdk.Horizon && StellarSdk.Horizon.Server) {
            console.log("DIAGNOSTIC RESULT: 'StellarSdk.Horizon.Server' was found!");
        } else {
            console.log("DIAGNOSTIC RESULT: Could not find 'Server' constructor at the expected locations.");
        }
        
        console.log("--- DIAGNOSTIC TEST FINISHED ---");

        // फ्रंटएंड को एक एरर मैसेज भेजें ताकि हम लॉग्स देख सकें
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: "Diagnostic test complete. Please check the Netlify function logs." })
        };

    } catch (err) {
        console.error("CRITICAL ERROR DURING DIAGNOSTIC:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: `Critical diagnostic error: ${err.message}` })
        };
    }
};
