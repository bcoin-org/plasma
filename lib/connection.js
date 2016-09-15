'use strict';

var EventEmitter = require('events').EventEmitter;
var bcoin = require('bcoin');
var utils = bcoin.utils;
var crypto = bcoin.crypto;
var assert = utils.assert;
var AEAD = require('./aead');

/**
 * Lightning Connection
 * @constructor
 */

function Connection() {
  if (!(this instanceof Connection))
    return new Connection();

  EventEmitter.call(this);

  this.remotePub = null;
  this.remoteID = null;
  this.authed = false;
  this.local = new AEAD.Stream();
  this.remote = new AEAD.Stream();
  this.viaPBX = false;
  this.pbxIncoming = null;
  this.pbxOutgoing = null;
  this.version = 0;
  this.socket = null;

  this.readQueue = [];
  this.readCallback = null;
  this.pending = [];
  this.total = 0;
  this.waiting = 2;
  this.hasSize = false;
}

utils.inherits(Connection, EventEmitter);

Connection.prototype.error = function error(err) {
  this.emit('error', new Error(err));
};

Connection.prototype.connect = function connect(myID, addr, remoteID) {
  var self = this;
  var net = require('net');

  this.socket = net.connect(10011, addr);

  this.socket.on('error', function(err) {
    self.emit('error', err);
  });

  this.socket.on('connect', function() {
    self._onConnect(myID, addr, remoteID);
  });

  this.socket.on('data', function(data) {
    self.feed(data);
  });
};

Connection.prototype._onConnect = function _onConnect(myID, addr, remoteID) {
  var ourPriv, ourPub;

  switch (remoteID.length) {
    case 20:
      this.remoteID = remoteID;
      break;
    case 33:
      this.remoteID = crypto.hash160(remoteID);
      break;
    default:
      throw new Error('Bad LNID size.');
  }

  ourPriv = bcoin.ec.generatePrivateKey();
  ourPub = bcoin.ec.publicKeyCreate(ourPriv, true);

  this.writeClear(ourPub);

  this.readClear(33, function(theirPub) {
    var sessionKey = crypto.sha256(bcoin.ec.ecdh(theirPub, ourPriv));

    this.local.seqHi = 0;
    this.local.seqLo = 0;
    this.remote.seqHi = (1 << 31) >>> 0;
    this.remote.seqLo = 0;

    this.remote.init(sessionKey);
    this.local.init(sessionKey);

    this.remotePub = theirPub;
    this.authed = false;

    if (remoteID.length === 20) {
      this.authPubkeyhash(myID, remoteID, ourPub);
      return;
    }

    this.authPubkey(myID, remoteID, ourPub);
  });
};

Connection.prototype.authPubkey = function authPubkey(myID, theirPub, localPub) {
  var theirPKH = crypto.hash160(theirPub);
  var idDH = crypto.sha256(bcoin.ec.ecdh(theirPub, myID));
  var myProof = crypto.hash160(concat(theirPub, idDH));
  var myPub = bcoin.ec.publicKeyCreate(myID, true);
  var authMsg;

  assert(!this.authed);

  authMsg = new Buffer(73);
  myPub.copy(authMsg, 0);
  theirPKH.copy(authMsg, 33);
  myProof.copy(authMsg, 53);

  this.writeRaw(authMsg);

  this.readRaw(20, function(response) {
    var theirProof = crypto.hash160(concat(localPub, idDH));

    assert(response.length === 20);

    if (!crypto.ccmp(response, theirProof))
      return this.error('Invalid proof.');

    this.remotePub = theirPub;
    this.remoteID = crypto.hash160(theirPub);
    this.authed = true;
    this.emit('connect');
  });
};

Connection.prototype.authPubkeyhash = function authPubkeyhash(myID, theirPKH, localPub) {
  var myPub = bcoin.ec.publicKeyCreate(myID, true);
  var greeting;

  assert(!this.authed);
  assert(theirPKH.length === 20);

  greeting = new Buffer(53);
  myPub.copy(greeting, 0);
  theirPKH.copy(greeting, 33);

  this.writeRaw(greeting);

  this.readRaw(53, function(response) {
    var theirPub = response.slice(0, 33);
    var idDH = crypto.sha256(bcoin.ec.ecdh(theirPub, myID));
    var theirProof = crypto.hash160(concat(localPub, idDH));
    var myProof;

    if (!crypto.ccmp(response.slice(33), theirProof))
      return this.error('Invalid proof.');

    myProof = crypto.hash160(concat(this.remotePub, idDH));

    this.writeRaw(myProof);

    this.remotePub = theirPub;
    this.remoteID = crypto.hash160(theirPub);
    this.authed = true;
    this.emit('connect');
  });
};

Connection.prototype.writeClear = function writeClear(payload) {
  var packet = new Buffer(2 + payload.length);
  packet.writeUInt16BE(payload.length, 0, true);
  payload.copy(packet, 2);
  this.socket.write(packet);
};

Connection.prototype.readClear = function readClear(size, callback) {
  this.readQueue.push(new QueuedRead(size, callback));
};

Connection.prototype.writeRaw = function writeRaw(data) {
  this.socket.write(data);
};

Connection.prototype.readRaw = function readRaw(size, callback) {
  assert(!this.hasSize);
  assert(this.waiting === 2);
  this.waiting = size;
  this.readCallback = callback;
};

Connection.prototype.feed = function feed(data) {
  var chunk;

  this.total += data.length;
  this.pending.push(data);

  while (this.total >= this.waiting) {
    chunk = this.read(this.waiting);
    this.parse(chunk);
  }
};

Connection.prototype.read = function read(size) {
  var pending, chunk, off, len;

  assert(this.total >= size, 'Reading too much.');

  if (size === 0)
    return new Buffer(0);

  pending = this.pending[0];

  if (pending.length > size) {
    chunk = pending.slice(0, size);
    this.pending[0] = pending.slice(size);
    this.total -= chunk.length;
    return chunk;
  }

  if (pending.length === size) {
    chunk = this.pending.shift();
    this.total -= chunk.length;
    return chunk;
  }

  chunk = new Buffer(size);
  off = 0;
  len = 0;

  while (off < chunk.length) {
    pending = this.pending[0];
    len = pending.copy(chunk, off);
    if (len === pending.length)
      this.pending.shift();
    else
      this.pending[0] = pending.slice(len);
    off += len;
  }

  assert.equal(off, chunk.length);

  this.total -= chunk.length;

  return chunk;
};

Connection.prototype.parse = function parse(data) {
  var size, payload, tag, item;

  if (!this.authed) {
    if (this.readCallback) {
      this.hasSize = false;
      this.waiting = 2;
      item = this.readCallback;
      this.readCallback = null;
      item.call(this, data);
      return;
    }

    if (!this.hasSize) {
      size = data.readUInt16BE(0, true);

      if (size < 12) {
        this.waiting = 2;
        this.emit('error', new Error('Bad packet size.'));
        return;
      }

      this.hasSize = true;
      this.waiting = size;

      return;
    }

    this.hasSize = false;
    this.waiting = 2;

    if (this.readQueue.length > 0) {
      item = this.readQueue.shift();
      if (item.size !== data.length)
        return this.error('Bad packet size.');
      item.callback.call(this, data);
      return;
    }

    this.emit('data', data);

    return;
  }

  if (!this.hasSize) {
    size = this.local.decryptSize(data);

    if (size < 2) {
      this.waiting = 2;
      this.error('Bad packet size.');
      return;
    }

    this.hasSize = true;
    this.waiting = size;

    return;
  }

  payload = data.slice(0, this.waiting - 16);
  tag = data.slice(this.waiting - 16, this.waiting);

  this.hasSize = false;
  this.waiting = 2;

  // Authenticate payload before decrypting.
  // This ensures the cipher state isn't altered
  // if the payload integrity has been compromised.
  this.local.auth(payload);
  this.local.finish();

  if (!this.local.verify(tag)) {
    this.local.sequence();
    this.error('Bad tag.');
    return;
  }

  this.local.decrypt(payload);
  this.local.sequence();

  this.emit('data', payload);
};

Connection.prototype.write = function write(payload) {
  var packet = new Buffer(2 + payload.length + 16);

  this.remote.encryptSize(payload.length + 16).copy(packet, 0);
  this.remote.encrypt(payload).copy(packet, 2);
  this.remote.finish().copy(packet, 2 + payload.length);
  this.remote.sequence();

  this.socket.write(packet);
};

/*
 * Helpers
 */

function QueuedRead(size, callback) {
  this.size = size;
  this.callback = callback;
}

function concat(b1, b2) {
  var buf = new Buffer(b1.length + b2.length);
  b1.copy(buf, 0);
  b2.copy(buf, b1.length);
  return buf;
}

module.exports = Connection;
