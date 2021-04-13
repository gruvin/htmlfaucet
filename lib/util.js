const debug = require('debug')('util');
const htmlcoin = require('htmlcoinjs-lib');
const address = require('bitcoinjs-lib').address;
const InsightExplorer = require('insight-explorer').Insight;
const insight = new InsightExplorer('https://explorer.htmlcoin.com/api', false);
const axios = require('axios');
const config = require('./config.js');
const db = require('./database.js');

 // check for robots using Google's reCAPTCHA service
const _reCAPTCHA = (req) => {
    return new Promise((resolve, reject) => {

        let toAddress = req.body.address || "";
        let token = req.body['g-recaptcha-response'];
        let remoteip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        let query_remoteip = (typeof remoteip != 'undefined') ? '&remoteip=${remoteip}' : '';
        let url = `https://www.google.com/recaptcha/api/siteverify?secret=${config.recaptchaSecret}&response=${token}${query_remoteip}`;
        debug('reCaptcha post URL: %s', url);
   
        // What sayeth thou o'mighty Google? ...
        axios.post(url)
            .then((captchaResponse) => {
                var response = captchaResponse.data;
                debug('reCaptcha response.data = %O', response);
                if (typeof response !== 'undefined' 
                        && response.success === true 
                        && response.score >= 0.1
                        && response.action == 'drippage') {
                    debug('reCaptcha passed');
                    if (req.body.address && req.body.address[0] == 'H') 
                        resolve(req.body.address);
                    else
                        reject('Invalid HTMLCOIN address')
                } else {
                    console.log('reCaptcha Failed (funny business): %O', response)
                    reject('Failed reCAPTCHA test. Not a robot? Wait a few minutes, reload the page, then try again.');
                }
            })
            .catch((err) => {
                debug('reCaptcha failed (api call): err = %O', err);
                reject('Netowork error (reCAPTCHA api)');
            })
        ;
    });
}

const _checkValidAddress = (toAddress) => {
    debug('Validating HTMLCOIN adddress "%s"', toAddress);

    if (typeof toAddress == 'undefined' || toAddress == '')
        return Promise.reject('Must provide an address to receive HTML');

    try {
        address.fromBase58Check(toAddress);
    } catch(e) {
        debug('Invalid HTMLCOIN address? %s, %O', toAddress, e);
        return Promise.reject(`Not a valid HTMLCOIN address: ${toAddress}`);
    }
    return Promise.resolve(toAddress);
}

// Warning: SQLite is not Promise aware and will throw even for simple SQL syntax errors
const _dbTimeCheck = (address) => { 
    return new Promise((resolve, reject) => {
        debug('Checking DB for last drip on address "%s"', address);
        try {
            // check if/when last time this address got watered
            db.get(`SELECT address, ((julianday() - julianday(time))  >= (${config.reuseWaitHours}/24.0)) AS expired,
                    strftime('%Y-%m-%d %H:%M:%S', time, '+${config.reuseWaitHours} hours') as expires
                    FROM drips WHERE address = ?`, 
                    [ address ], 
                    (err, row) => {
                if (err) throw new Error(err);
                debug('... query result %O', row);
                if (row && !row.expired) reject(`Sorry, you need to wait ${config.reuseWaitHours} hours between transactions – until ${row.expires} UTC`);
                resolve(address);
            })
        } catch(e) {
            console.error('** SQLite threw an error: ' + e + '\nCONTINUING, like it never happened.');
            resolve(address) // POLICY: Our fault so give the user a free pass
        }
    });
}

const _dbRecordTime = (address, amount, txid) => {
    return new Promise((resolve, reject) => {
        try { // SQLite just throws for SQL syntax errors ...
            let sql = 'INSERT INTO drips (time, address, amount, txid) VALUES (julianday(), ? , ?, ?)'
            let values = [ address, amount, txid ];
            debug('Adding DB time record: "%s, %o"', sql, values);
            db.run( sql, values, (err) => {
                if (err) {
                    sql = 'UPDATE drips SET time=julianday(), txid=? WHERE address = ?';
                    values = [ txid, address ];
                    debug('INSERT failed. Trying UPDATE: "%s, %o"', sql, values);
                    db.run(sql, values, (err) => {
                        debug('Update also failed! ERR:', err);
                        if (err) throw new Error(err);
                        resolve(txid);
                    });
                }
                resolve(txid);
            })
        } catch(e) {
            console.error('** SQLite threw an error: ' + e + '\nCONTINUING, like it never happened.');
            resolve(txid) // POLICY: Our fault so give the user a free pass
        }
    });
}

const _buildDripTransaction = (address) => {
    const amount = config.outputHTML
    const relayFee = config.relayFee
    return new Promise(async (resolve, reject) => {

        const playingFair = await _dbTimeCheck(address).catch(e => reject(e))

        insight.getAddressUtxo(
            config.keyPair.getAddress()
        ).then((utxos) => { 
            return new Promise((resolve, reject) => {
                debug('Insight provided UTXO list: %O', utxos);

                // translate data to format needed by buildPubKeyHashTransaction(), below
                try {
                    var utxoList = utxos.reduce((result, item) => {
                        if (item.confirmations && item.confirmations >= 1) {
                            result.push({
                                address: item.address,
                                txid: item.txid,
                                confirmations: item.confirmations,
                                isStake: item.isStake,
                                amount: item.amount,
                                value: item.satoshis,
                                hash: item.txid,
                                pos: item.vout
                            });
                        }
                        return result;
                    }, []);
                } catch (e) {
                    console.error('*** UXTO TRANSLATION FAILED. Error: %O\n Input: %O ', e, utxos);
                    reject('Internal error (logged)');
                }

                debug('Filtered and translated UTXO list: %O', utxoList);

                debug('Building raw transaction from: %O', { address, amount, relayFee, utxoList });
                
                let rawTransaction = "";
                try {
                    rawTransaction = htmlcoin.utils.buildPubKeyHashTransaction(config.keyPair, address, amount, relayFee, utxoList);
                    debug('Raw transaction: %O', rawTransaction);
                    resolve({ address, amount, rawTransaction});
                } catch(e) {
                    let eo = { 
                        keypair: '[private]', 
                        address: toAddress, 
                        amount: amount, 
                        relayFee: config.relayFee,
                        utxos: utxoList
                    };
                    debug('Transaction build failed: %O', eo);
                    reject('Transaction build failed. Error has been logged.');
                }
            });
        })
        .then(transactionData => resolve(transactionData))
        .catch((e) => {
            reject(e); // bubble up
        });
    });
}

const _broadcastTransaction = (transactionData) => {
    debug('Broadcasting transaction: %O', transactionData);

    const { address, amount, rawTransaction } = transactionData
    
    return new Promise((resolve, reject) => {

        switch (config.broadcastVia) {
            case 'rpc': {
                debug('Sending transaction via wallet full node RPC provider');
                axios({
                    baseURL: 'http://localhost:14889',
                    method: 'post',
                    auth: {
                        username: config.rpcUser,
                        password: config.rpcPass
                    },
                    data: {
                        jsonrpc: '1.0', 
                        id: 'htmlfaucet',
                        method: 'sendrawtransaction', 
                        params: [ rawTransaction ]
                    },
                    timeout: 30,
                }).then(response => {
                    debug("[rpc]sendrawtransaction response: %O", response.data);
                    
                    const txID = response.data.result;
                    _dbRecordTime(address, amount, txID)
                    resolve(txID);

                }).catch(error => {
                    if (error.code === 'ECONNABORTED') {
                        reject({ 
                            error: 'TIMEOUT',
                            reason: 'Connection to HTMLCOIN RPC node timed out.'
                        });
                    } else if (error.response) {
                        // The request was made and the server responded with a status code
                        // that falls out of the range of 2xx
                        console.error('Transaction broadcast failed: Status: %s Error: %s\nResponse Headers: %O',
                                error.response.status, error.response.data, error.response.headers
                        );
                        reject({ 
                            error: 'Transaction broadcast failed',
                            reason: error.response.data
                        });
                    } else if (error.request) {
                        // The request was made but no response was received
                        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                        // http.ClientRequest in node.js
                        console.error('Transaction broadcast post returned no response. Request was: %O', error.request);
                        reject({ 
                            error: 'Transaction broadcast failed',
                            reason: 'Transaction transmission accepted but no transaction ID was received.'
                        });
                    } else {
                        // Something happened in setting up the request that triggered an Error
                        console.error('Transaction broadcast failed. Message: %o', error.message);
                        reject({ 
                            error: 'Transaction broadcast failed',
                            reason: error.message
                        });
                    }
                });
                break;
            } // RPC

            default: { // Insight
                debug('Sending transaction via Insight provider');
                insight
                    .broadcastRawTransaction(rawTransaction)
                    .then(async response => { 
                        debug("[insight]/tx/send response:", response.txid);
                        const txID = response.txid;
                        await _dbRecordTime(address, amount, txID)
                        resolve(txID);
                    })
                    .catch((err) => { 
                        debug('TX transmission failed: %O', err);
                        reject({ 
                            error: 'Transaction broadcast failed',
                            reason: err.toString()
                        });
                    });
                ;
            } // Insight

        } // switch
    }) // Promise
}

module.exports = {
    reCAPTCHA: _reCAPTCHA,
    dbTimeCheck: _dbTimeCheck,
    checkValidAddress: _checkValidAddress,
    buildDripTransaction: _buildDripTransaction,
    broadcastTransaction: _broadcastTransaction,
    dbRecordTime: _dbRecordTime
}

