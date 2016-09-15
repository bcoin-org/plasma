'use strict';

var EventEmitter = require('events').EventEmitter;
var bcoin = require('bcoin');
var utils = bcoin.utils;
var crypto = bcoin.crypto;
var assert = utils.assert;
var constants = bcoin.constants;
var chachapoly = require('bcoin/lib/crypto/chachapoly');
var wire = require('./wire');
var Connection = require('./connection');
var Parser = require('./parser');
var Framer = require('./framer');

function Peer(myID, addr, lnid, network) {
  var self = this;
  EventEmitter.call(this);
  this.myID = myID;
  this.addr = addr;
  this.lnid = lnid;
  this.network = network || bcoin.network.get();
  this.conn = new Connection();
  this.parser = new Parser(this);
  this.framer = new Framer(this);
  this.conn.on('connect', function() {
    self.emit('connect');
  });
  this.conn.on('data', function(data) {
    self.parser.feed(data);
  });
  this.conn.on('error', function(err) {
    self.emit('error', err);
  });
  this.parser.on('packet', function(msg) {
    console.log('Received packet:');
    console.log(msg);
    self.emit('packet', msg);
  });
}

utils.inherits(Peer, EventEmitter);

Peer.prototype.connect = function connect() {
  this.conn.connect(this.myID, this.addr, this.lnid);
};

Peer.prototype.send = function send(msg) {
  console.log('Sending packet:');
  console.log(msg);
  return this.write(msg.cmd, msg.toRaw());
};

Peer.prototype.frame = function frame(cmd, payload) {
  return this.framer.packet(cmd, payload);
};

Peer.prototype.write = function write(cmd, payload) {
  return this.conn.write(this.frame(cmd, payload));
};

module.exports = Peer;
