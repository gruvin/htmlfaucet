const debug = require('debug')('config')
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const htmlcoin = require('htmlcoinjs-lib');

let _testNet = false;
let _pathToSecretDataJSONFile = '../../htmlfaucet.secrets.json';
let dataPath = path.normalize(path.join(__dirname, _pathToSecretDataJSONFile));

let secretData = {};
try {
    let rawSecretData = fs.readFileSync(dataPath, 'utf8');
    debug(rawSecretData);
    secretData = JSON.parse(rawSecretData);
    debug(secretData);
} catch(e) {
    debug(e);
    throw new Error('Unable to retrieve key secrets data\n');
}

module.exports = {

    testNet: _testNet,
    
    network:  ((_testNet) ? 
        htmlcoin.networks.htmlcoin_testnet :
        htmlcoin.networks.htmlcoin
    ),

    faucetPrivateKey: secretData['faucet_private_key'],

    providerURL:  ((_testNet) ? 
        "https://testnet.htmlcoin.com" :
        "https://explorer.htmlcoin.com"
    ),

    relayFee:  0.00103200,
    
    outputHTML: 10.0,

    recaptcha_secret: secretData['recaptcha_secret']
}
