'use strict';

var bcoin = require('bcoin');
var utils = bcoin.utils;
var assert = utils.assert;
var chachapoly = require('bcoin/lib/crypto/chachapoly');

/**
 * AEAD (used for bip151)
 * @exports AEAD
 * @see https://github.com/openssh/openssh-portable
 * @see https://tools.ietf.org/html/rfc7539#section-2.8
 * @constructor
 */

function NonstandardAEAD() {
  if (!(this instanceof NonstandardAEAD))
    return new NonstandardAEAD();

  this.chacha20 = new chachapoly.ChaCha20();
  this.poly1305 = new chachapoly.Poly1305();
  this.aadLen = 0;
  this.cipherLen = 0;
  this.polyKey = null;
}

/**
 * Initialize the AEAD with a key and iv.
 * @param {Buffer} key
 * @param {Buffer} iv - IV / packet sequence number.
 */

NonstandardAEAD.prototype.init = function init(key, iv) {
  var polyKey = new Buffer(32);
  polyKey.fill(0);

  this.chacha20.init(key, iv);
  this.chacha20.encrypt(polyKey);
  this.poly1305.init(polyKey);

  // We need to encrypt a full block
  // to get the cipher in the correct state.
  this.chacha20.encrypt(new Buffer(32));

  // Counter should be one.
  assert(this.chacha20.getCounter() === 1);

  // Expose for debugging.
  this.polyKey = polyKey;

  this.aadLen = 0;
  this.cipherLen = 0;
};

/**
 * Update the aad (will be finalized
 * on an encrypt/decrypt call).
 * @param {Buffer} aad
 */

NonstandardAEAD.prototype.aad = function _aad(aad) {
  assert(this.cipherLen === 0, 'Cannot update aad.');
  this.poly1305.update(aad);
  this.aadLen += aad.length;
};

/**
 * Finalize AAD.
 */

NonstandardAEAD.prototype.finalAAD = function finalAAD() {
  var lo, hi, len;

  if (this.cipherLen !== 0)
    return;

  this.pad16(this.aadLen);

  len = new Buffer(8);

  lo = this.aadLen % 0x100000000;
  hi = (this.aadLen - lo) / 0x100000000;
  len.writeUInt32LE(lo, 0, true);
  len.writeUInt32LE(hi, 4, true);

  this.poly1305.update(len);
};

/**
 * Encrypt a piece of data.
 * @param {Buffer} data
 */

NonstandardAEAD.prototype.encrypt = function encrypt(data) {
  this.finalAAD();

  this.chacha20.encrypt(data);
  this.poly1305.update(data);
  this.cipherLen += data.length;

  return data;
};

/**
 * Decrypt a piece of data.
 * @param {Buffer} data
 */

NonstandardAEAD.prototype.decrypt = function decrypt(data) {
  this.finalAAD();

  this.cipherLen += data.length;
  this.poly1305.update(data);
  this.chacha20.encrypt(data);

  return data;
};

/**
 * Authenticate data without decrypting.
 * @param {Buffer} data
 */

NonstandardAEAD.prototype.auth = function auth(data) {
  this.finalAAD();

  this.cipherLen += data.length;
  this.poly1305.update(data);

  return data;
};

/**
 * Finalize the aead and generate a MAC.
 * @returns {Buffer} MAC
 */

NonstandardAEAD.prototype.finish = function finish() {
  var len = new Buffer(8);
  var lo, hi;

  this.finalAAD();

  this.pad16(this.cipherLen);

  len = new Buffer(8);

  lo = this.cipherLen % 0x100000000;
  hi = (this.cipherLen - lo) / 0x100000000;
  len.writeUInt32LE(lo, 0, true);
  len.writeUInt32LE(hi, 4, true);

  this.poly1305.update(len);

  return this.poly1305.finish();
};

/**
 * Pad a chunk before updating mac.
 * @private
 * @param {Number} size
 */

NonstandardAEAD.prototype.pad16 = function pad16(size) {
  // NOP
};

/**
 * AEAD Stream
 * @constructor
 */

function AEADStream() {
  this.aead = new NonstandardAEAD();

  this.tag = null;
  this.seqLo = 0;
  this.seqHi = 0;
  this.iv = new Buffer(8);
  this.iv.fill(0);

  this.highWaterMark = 1024 * (1 << 20);
  this.processed = 0;
  this.lastRekey = 0;
}

AEADStream.prototype.init = function init(key) {
  this.update();
  this.aead.init(key, this.iv);
  this.lastRekey = utils.now();
};

AEADStream.prototype.sequence = function sequence() {
  // Wrap sequence number a la openssh.
  if (++this.seqLo === 0x100000000) {
    this.seqLo = 0;
    if (++this.seqHi === 0x100000000)
      this.seqHi = 0;
  }

  this.update();

  // State of the ciphers is
  // unaltered aside from the iv.
  this.aead.init(null, this.iv);
};

AEADStream.prototype.update = function update() {
  this.iv.writeUInt32BE(this.seqHi, 0, true);
  this.iv.writeUInt32BE(this.seqLo, 4, true);
  return this.iv;
};

AEADStream.prototype.encryptSize = function encryptSize(size) {
  var data = new Buffer(2);
  data.writeUInt16BE(size, 0, true);
  // this.aead.aad(data);
  return data;
};

AEADStream.prototype.decryptSize = function decryptSize(data) {
  // this.aead.aad(data);
  return data.readUInt16BE(0, true);
};

AEADStream.prototype.encrypt = function encrypt(data) {
  return this.aead.encrypt(data);
};

AEADStream.prototype.decrypt = function decrypt(data) {
  return this.aead.chacha20.encrypt(data);
};

AEADStream.prototype.auth = function auth(data) {
  return this.aead.auth(data);
};

AEADStream.prototype.finish = function finish() {
  this.tag = this.aead.finish();
  return this.tag;
};

AEADStream.prototype.verify = function verify(tag) {
  return chachapoly.Poly1305.verify(this.tag, tag);
};

/*
 * Expose
 */

exports = NonstandardAEAD;
exports.Stream = AEADStream;
module.exports = exports;
