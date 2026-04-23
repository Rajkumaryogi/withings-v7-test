const crypto = require('crypto');
const config = require('../../config.json');

function sign(params) {
    const params_to_sign = {
        action: params.action,
        client_id: params.client_id
    };
    
    if (params.timestamp && params.action === 'getnonce') {
        params_to_sign.timestamp = params.timestamp;
    }
    if (params.nonce) {
        params_to_sign.nonce = params.nonce;
    }
    
    // Sort parameters alphabetically
    const sorted_keys = Object.keys(params_to_sign).sort();
    const sorted_values = sorted_keys.map(key => params_to_sign[key]).join(',');
    
    const hmac = crypto.createHmac('sha256', config.client_secret);
    hmac.update(sorted_values);
    return hmac.digest("hex");
}

function getCurrentTimestamp() {
    return Math.round(Date.now() / 1000);
}

module.exports = {
    sign,
    getCurrentTimestamp
};