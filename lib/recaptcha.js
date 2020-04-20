const axios = require('axios');
const debug = require('debug')('recaptcha');
const config = require('./config.js');

module.exports = {
    verify: (token, remoteip) => {
        let query_remoteip = (typeof remoteip != 'undefined') ? '&remoteip=${remoteip}' : '';

        let url = `https://www.google.com/recaptcha/api/siteverify?secret=${config.recaptchaSecret}&response=${token}${query_remoteip}`;

        debug('reCaptcha post URL: %s', url);
       
        return new Promise((resolve, reject) => {

            // check reCaptcha token with Google
            axios.post(url)
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
                        reject('Request failed anti-abuse testing. (reCAPTCHA) Try waiting a few minutes then reload the page and try again.');
                    }
                })
                .catch((err) => {
                    debug('reCaptcha failed (api call): err = %O', err);
                    reject('reCaptcha failed (api call) **DEBUG**');
                })
            ;
        });
    }
}
