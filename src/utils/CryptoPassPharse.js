import CryptoJS from 'crypto-js';
import ENC from 'crypto-js/enc-utf8';

const iterations = 10000;
//environment: dev
// const serverApi = 'https://ck-server-demo.herokuapp.com'
const serverApi = 'https://op.clearkeep.me';
const str = 'AAAAAAAAAAAAAAAAAAAAAA==';

function CryptoPassPhrase(pass, userID) {
    const salt = CryptoJS.lib.WordArray.random(32);
    const key = CryptoJS.PBKDF2(`${userID}COLIAKIP`, salt, {
        keySize: 8,
        iterations: iterations
    });
    let iv = CryptoJS.enc.Base64.parse(str);
    const encrypted = CryptoJS.AES.encrypt(`${pass}COLIAKIP`, key, {
        iv: iv,
        padding: CryptoJS.pad.Pkcs7,
        mode: CryptoJS.mode.CBC
    });
    // salt, iv will be hex 32 in length
    // append them to the ciphertext for use  in decryption
    const transitmessage = encrypted.toString();
    const saltB64 = salt.toString(CryptoJS.enc.Base64);
    return `${saltB64}:${transitmessage}`;
}

function DeCryptoPassPhrase(userID, passPhrase) {
    // Decrypt
    const arrSalt = passPhrase.split(':');
    const key = CryptoJS.PBKDF2(`${userID}COLIAKIP`, CryptoJS.enc.Base64.parse(arrSalt[0]), {
        keySize: 8,
        iterations: iterations
    });
    const iv = CryptoJS.enc.Base64.parse(str);
    const transitmessage = CryptoJS.AES.decrypt(arrSalt[1], key, {
        iv: iv,
        padding: CryptoJS.pad.Pkcs7,
        mode: CryptoJS.mode.CBC
    });
    return transitmessage.toString(ENC);
}

function getPassPhrase(access_token) {
    const myInit = {
        headers: {
            Authorization: 'Bearer ' + access_token
        }
    };
    const url = `${serverApi}/api/user/get-passphrase`;
    return fetch(url, myInit)
        .then(res => res.json())
        .then(function(response) {
            if (response.errorCode === 0) {
                return response.data.passphrase;
            }
            return null;
        })
        .catch(error => console.error('Error:', error));
}

function createPassPhrase(userPass, userID, access_token) {
    const keyPass = CryptoPassPhrase(userPass, userID);
    const data = {
        passphrase: keyPass
    };
    const myInit = {
        method: 'post',
        headers: {
            Authorization: 'Bearer ' + access_token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    };
    const url = `${serverApi}/api/user/create-passphrase`;
    return fetch(url, myInit)
        .then(res => res.json())
        .catch(error => console.error('Error:', error));
}

function deletePhrase(access_token) {
    const url = `${serverApi}/api/user/delete-passphrase`;
    const init = {
        method: 'delete',
        headers: {
            Authorization: 'Bearer ' + access_token
        }
    };
    return fetch(url, init);
}

export default {
    CryptoPassPhrase,
    DeCryptoPassPhrase,
    getPassPhrase,
    createPassPhrase,
    deletePhrase
};
