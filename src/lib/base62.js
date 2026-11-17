'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Cryptographically secure Base62 short-code generator.
 * crypto.randomInt is unbiased (rejection sampling), so every character is
 * uniformly distributed. 62^7 = 3.52 trillion possible 7-character codes.
 */
function generateCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

module.exports = { generateCode, ALPHABET };
