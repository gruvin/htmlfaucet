const fs = require('fs');
const path = require('path');
const express = require('express');
const exphbs  = require('express-handlebars');
const exphbs_sections = require('express-handlebars-sections');
const logger = require('morgan');
const debug = require('debug')('app');
const bodyParser = require('body-parser');
const http = require('http');
const rfs = require('rotating-file-stream');
const config = require('./lib/config.js');
const util = require('./lib/util.js');

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

var accessLogStream = rfs.createStream('access.log', {
    interval: '7d',
    path: path.join(__dirname, 'log')
});
app.use(logger('combined', { stream: accessLogStream }));

app.use(bodyParser.urlencoded({extended: false}));

var hbs = exphbs.create({ 
    extname: '.hbs',
    helpers: {
        app_prefix: () => { return app_prefix; },
        outputHTML: config.outputHTML.toFixed(1),
        faucetAddress: config.keyPair.getAddress()
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
    let _databaseID = null;
    let _txID = '';
    util.reCAPTCHA(req)
    .then(() => util.checkValidAddress(req.body.address)) // Promise abstracted synchronous but may become async some day
    .then(() => util.dbTimeCheck(req.body.address))
    .then((databaseID) => {
        _databaseID = databaseID;
        return util.buildDripTransaction(req.body.address, config.outputHTML, config.relayFee); // contains async xtxo fetch
    })
    .then((rawTransaction) => util.broadcastTransaction(rawTransaction))
    .then((txid) => {
        _txID = txid;
        return util.dbRecordTime(_databaseID, req.body.address, txid);
    })
    .then(() => {
        res.json({
            success: true,
            toAddress: req.body.address,
            amount: config.outputHTML,
            txID: _txID
        })
    })
    .catch((err) => {
        debug('/process catch() err: %O', err);
        if (typeof err.error !== 'undefined')
            res.json({ error: err.error, reason: err.reason });
        else
            res.json({ error: err });
    })
});

app.listen(server_port, server_hostname, () => {
    console.info(`Server running at http://${server_hostname}:${server_port}/`);
});
