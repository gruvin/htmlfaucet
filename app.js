const express = require('express');
const exphbs  = require('express-handlebars');
const exphbs_sections = require('express-handlebars-sections');
const logger = require('morgan');
const debug = require('debug')('app');
const bodyParser = require('body-parser');
const http = require('http');
const htmlcoin = require('htmlcoinjs-lib');
const address = require('bitcoinjs-lib').address;
const Insight = require('insight-explorer').Insight;
const insight = new Insight('https://explorer.htmlcoin.com/api');
const axios = require('axios');
const config = require('./lib/config.js');
const fs = require('fs');
const path = require('path');
const recaptcha = require('./lib/recaptcha.js');

const keyPair = new htmlcoin.ECPair.fromWIF(config.faucetPrivateKey, config.network);

// Follows verily an sickening, untoward comotion of a nuisence, as concerns cPanel and mod_passenger (ick)
let app_prefix = '';
let server_hostname = '0.0.0.0';
let server_port = 5000;
const cpanelDir = path.join('..', '.cpanel');
if (!process.env.DEBUG && fs.existsSync(cpanelDir) && fs.lstatSync(cpanelDir).isDirectory()) {
    debug('cPanel/mod_passenger detected');

    let logDir = './log';
    let logFile = 'console.log';

    debug('redirecting console to %s/%s', logDir, logFile);

    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    let __console = fs.createWriteStream(path.join(logDir, logFile), { flags: 'a' });
    process.stdout.write = process.stderr.write = __console.write.bind(__console);

    // cPanel/mod_passenger mangles relative paths, so we need to be explicit. (sigh)
    app_prefix = '/'+path.basename(path.resolve());

    server_hostname = '127.0.0.1';
    server_port = 3000;
}

var app = express();

app.use(logger("short"));
app.use(bodyParser.urlencoded({extended: false}));

var hbs = exphbs.create({ 
    extname: '.hbs',
    helpers: {
        app_prefix: () => { return app_prefix; },
        outputHTML: config.outputHTML.toFixed(1),
        faucetAddress: new htmlcoin.ECPair.fromWIF(config.faucetPrivateKey, config.network).getAddress()
    }
});
exphbs_sections(hbs);

app.engine('.hbs', hbs.engine);
app.set('view engine', '.hbs');

app.use(app_prefix+'/css', express.static(path.join(__dirname, '/static/css')));
app.use(app_prefix+'/js', express.static(path.join(__dirname, '/static/js')));
app.use(app_prefix+'/img', express.static(path.join(__dirname, '/static/img')));

app.get(app_prefix+'/', (req, res) => {
    res.render('home', { DEBUG: (process.env.DEBUG) ? true : false });
});

app.post(app_prefix+'/process', (req, res) => {
    let toAddress = req.body.address || "";
    let transactionID ="";

    let token = req.body['g-recaptcha-response'];
    let remoteip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    recaptcha
        .verify(token, remoteip)
        .then(() => {
            // check for valid address
            try {
                if (toAddress[0] == 'H') address.fromBase58Check(toAddress);
                else throw new Error();
            } catch(e) {
                throw new Error(`Not a valid HTMLCOIN address: ${toAddress}`);
            }
            
            insight
                .getAddressUtxo(keyPair.getAddress())

                // translate data to format needed by buildPubKeyHashTransaction(), below
                .then((utxos) => { 
                    // TODO: refactor this into ./lib/util.js
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

                    return new Promise((resolve, reject) => {
                        let rawTx = "";
                        try {
                            rawTx = htmlcoin.utils.buildPubKeyHashTransaction(keyPair, toAddress, config.outputHTML, config.relayFee, utxoList);
                            resolve(rawTx);
                        } catch(e) {
                            let eo = { 
                                keypair: '[private]', 
                                address: toAddress, 
                                amount: config.outputHTML, 
                                relayFee: config.relayFee,
                                utxoList: utxoList
                            };
                            debug('Transaction build failed: %O', eo);
                            reject(':( Transaction build failed. Error has been logged.');
                        }
                    });

                })
                .then((rawTx) => {
                    // TODO: refactor this into ./lib/util.js
                    
                    debug("Raw Transaction: %s", rawTx);

                    // broadcast the transaction
                    insight
                        .broadcastRawTransaction(rawTx)
                        .then((response) => { 
                            debug("[insight]/tx/send response:", response.txid);
                            res.json({ 
                                success: true,
                                toAddress: toAddress,
                                amount: config.outputHTML,
                                txID: response.txid
                            });
                        })
                        .catch((err) => { 
                            debug('TX transmission failed: %O', err);
                            res.json({ error: 'Transaction broadcast failed.', extra: err.toString() });
                        });
                    ; // insight (2/2)
                })
                .catch((err) => {
                    res.json({ error: err.toString() });
                });
            ; // insight (1/2)
        })
        .catch((err) => {
            res.json({ error: err.toString() });
        });
    ; // recaptcha
});

app.listen(server_port, server_hostname, () => {
    console.log(`Server running at http://${server_hostname}:${server_port}/`);
});
