const sqlite3 = require('sqlite3').verbose()
const debug = require('debug')('db');
const path = require('path');
const df = require('dateformat');
const config = require('./config.js');

const db = new sqlite3.Database(path.join(__dirname, '../db.sqlite'), (err) => {
    if (err) {
        // Cannot open database
        debug(err.message)
        throw err
    } else {
        debug('SQLite database connected.')
        db.run(
            `CREATE TABLE drips (
                address TEXT PRIMARY KEY,
                time TEXT,
                amount REAL,
                txid TEXT, 
                CONSTRAINT addr_unique UNIQUE (address)
            )`, (err) => {
            if (err) {
                if (err != 'Error: SQLITE_ERROR: table drips already exists') throw err;
                debug('DB table already exists (OK)');
            } else {
                // first record contains faucet wallet address (no particular reason)
                db.run(
                    'INSERT INTO drips (time, address, amount, txid) VALUES (julianday(), ? , ?, ?)', 
                    [ 
                        config.keyPair.getAddress(), 
                        0.0,
                        'INIT'
                    ]
                );
            }
        });  
    }
});

module.exports = db;

