const debug = require('debug')('config')
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const htmlcoin = require('htmlcoinjs-lib');

let _testNet = false;
const _network = ((_testNet) ? 
    htmlcoin.networks.htmlcoin_testnet :
    htmlcoin.networks.htmlcoin
);

let _pathToSecretDataJSONFile = '../../htmlfaucet.secrets.json';
let dataPath = path.normalize(path.join(__dirname, _pathToSecretDataJSONFile));

let secretData = {};
try {
    let rawSecretData = fs.readFileSync(dataPath, 'utf8');
    debug(rawSecretData);
    secretData = JSON.parse(rawSecretData);
    debug('SECRETS: %O', secretData);
} catch(e) {
    debug(e);
    throw new Error('Unable to retrieve key secrets data\n');
}

const _keyPair = new htmlcoin.ECPair.fromWIF(secretData['faucet_private_key'], _network);

module.exports = {

    testNet: _testNet,
    network: _network,
    keyPair: _keyPair,

    providerURL:  ((_testNet) ? 
        "https://testnet.htmlcoin.com" :
        "https://explorer.htmlcoin.com"
    ),

//    broadcastVia: 'rpc', // anything else implies ingight explorer /tx/send
    broadcastVia: 'explorer',
    rpcUser: secretData['rpc_user'] || '',
    rpcPass: secretData['rpc_pass'] || '',

    outputHTML: 5.0,
    relayFee: 0.00175200,

    recaptchaSecret: secretData['recaptcha_secret'],

    reuseWaitHours: 12.0
}
