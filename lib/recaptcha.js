const axios = require('axios');
const debug = require('debug')('recaptcha');
const config = require('./config.js');

module.exports = {

    verify: (token, remoteip) => {
        return new Promise((resolve, reject) => {
            let query_remoteip = (typeof remoteip != 'undefined') ? '&remoteip=${remoteip}' : '';
            let postURL = `https://www.google.com/recaptcha/api/siteverify?secret=${config.recaptchaSecret}&response=${token}${query_remoteip}`;
            debug('reCaptcha post URL: %s', url);
       
            // What sayeth thou o'mighty Google? ...
            axios.post(postURL, { timeout: 10000 })
                .then((captchaResponse) => {
                    var response = captchaResponse.data;
                    debug('reCaptcha response.data = %O', response);
                    if (typeof response !== 'undefined' 
                            && response.success === true 
                            && response.score >= 0.7
                            && response.action == 'drippage') {
                        debug('reCaptcha passed');
                        resolve();
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
}
