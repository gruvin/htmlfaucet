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
                        && response.score >= 0.7
                        && response.action == 'drippage') {
                    debug('reCaptcha passed');
                    resolve(response); // response probably won't be used but might as well return something
                } else {
                    debuglog('reCaptcha Failed (funny business): %O', response)
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
const _dbTimeCheck = (toAddress) => { 
    return new Promise((resolve, reject) => {
        debug('Checking DB for last drip on address "%s"', toAddress);
        try {
            // check if/when last time this address got watered
            db.get(`SELECT id, address, ((julianday() - julianday(time))  >= (${config.reuseWaitHours}/24.0)) AS expired,
                    strftime('%Y-%m-%d %H:%M:%S', time, '+${config.reuseWaitHours} hours') as expires
                    FROM drips WHERE address = ?`, 
                    [ toAddress ], 
                    (err, row) => {
                if (err) reject('Internal database error (time check)');
                debug('... query result %O', row);
                if (row && !row.expired) {
                    reject(`Sorry, you need to wait ${config.reuseWaitHours} hours between transactions – until ${row.expires} UTC`);
                }
                resolve((row) ? row.id : null); 
            })
        } catch(e) {
            console.error('*** DATABASE ERROR: ', e);
            reject('Internal database error (logged)');
        }
    }); 
}

const _buildDripTransaction = (toAddress, amount, relayFee) => {
    return new Promise((resolve, reject) => {
        insight.getAddressUtxo(
            config.keyPair.getAddress()
        ).then((utxos) => { 
            return new Promise((resolve, reject) => {
                debug('Insight provided UTXO list: %O', utxos);

                // translate data to format needed by buildPubKeyHashTransaction(), below
                try {
                    var utxoList = utxos.map(item => {
                        return {
                            address: item.address,
                            txid: item.txid,
                            confirmations: item.confirmations,
                            isStake: item.isStake,
                            amount: item.amount,
                            value: item.satoshis,
                            hash: item.txid,
                            pos: item.vout
                        }
                    });
                } catch (e) {
                    console.error('*** UXTO TRANSLATION FAILED. Error: %O\n Input: %O ', e, utxos);
                    reject('Internal error (logged)');
                }

                debug('Building raw transaction from: %O', { address: toAddress, value: amount, relay_fee: relayFee, utxos: utxoList });
                
                let rawTx = "";
                try {
                    rawTx = htmlcoin.utils.buildPubKeyHashTransaction(config.keyPair, toAddress, amount, relayFee, utxoList);
                    debug('Raw transaction: %O', rawTx);
                    resolve(rawTx);
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
        .then((rawTx) => { resolve(rawTx); })
        .catch((e) => {
            reject(e); // bubble up
        });
    });
}

const _broadcastTransaction = (rawTransaction) => {
    debug('Broadcasting transaction: %s', rawTransaction);
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
                }).then((response) => {
                    debug("[rpc]sendrawtransaction response: %O", response.data);
                    resolve(response.data.result /*txID*/);
                }).catch((error) => {
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
                info('Sending transaction via Insight provider');
                insight
                    .broadcastRawTransaction(rawTransaction)
                    .then((response) => { 
                        debug("[insight]/tx/send response:", response.txid);
                        resolve({ 
                            success: true,
                            toAddress: toAddress,
                            amount: config.outputHTML,
                            txID: response.txid
                        });
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

const _dbRecordTime = (dbid, address, amount, txid) => {
    // SQLite is not Promise aware and uses 'throw' for SQL syntax errors. We need to account for that ...
    return new Promise((resolve, reject) => {
        try {
            debug('dbRecordTime: %O', { DBID: dbid, addr: address, txID: txid });
            if (dbid) {
                let sql = 'UPDATE drips SET time=julianday(), txid=? WHERE id = ?';
                let values = [ txid, dbid ];
                debug('Updating DB time record: "%s, %o"', sql, values);
                db.run(sql, values, (err) => {
                    if (err) debug('Error updating time record for id: %s, address: %s, %O', dbid, address, err);
                });
            } else {
                let sql = 'INSERT INTO drips (time, address, amount, txid) VALUES (julianday(), ? , ?, ?)'
                let values = [ address, amount, txid ];
                debug('Adding DB time record: "%s, %o"', sql, values);
                db.run( sql, values, (err) => {
                   if (err) console.error('Error adding time record for address %s: %', address, err);
                });
            }
            resolve();
        } catch(e) {
            console.error('** SQLite threw an error: ' + e + '\nCONTINUING, like it never happened.');
            resolve(); // but we'll keep going anyway, since the TX has already broadcast
        }
    });
}

module.exports = {
    reCAPTCHA: _reCAPTCHA,
    dbTimeCheck: _dbTimeCheck,
    checkValidAddress: _checkValidAddress,
    buildDripTransaction: _buildDripTransaction,
    broadcastTransaction: _broadcastTransaction,
    dbRecordTime: _dbRecordTime
}

