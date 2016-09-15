'use strict';

var EventEmitter = require('events').EventEmitter;
var bcoin = require('bcoin');
var utils = bcoin.utils;
var crypto = bcoin.crypto;
var assert = utils.assert;
var constants = bcoin.constants;
var chachapoly = require('bcoin/lib/crypto/chachapoly');
var wire = require('./wire');
var Peer = require('./peer');

/*
var conn = new Connection();
var myID = bcoin.ec.generatePrivateKey();
var addr = '52.39.113.206';
var lnid = new Buffer('d64fd0c520b788b97c4a7cda33e5cd0379e2b180ace44fd9553e05776534c6a7', 'hex');
var hash = bcoin.utils.fromBase58('SZKbmbvudiHu6ScqDmz3o64ZViyy2JPcaY');
hash = hash.slice(1, 21);
conn.connect(myID, addr, hash);
conn.on('connect', function() {
  console.log('connected');
});
*/

var myID = bcoin.ec.generatePrivateKey();
var addr = '52.39.113.206';
var lnid = new Buffer('d64fd0c520b788b97c4a7cda33e5cd0379e2b180ace44fd9553e05776534c6a7', 'hex');
var hash = bcoin.utils.fromBase58('SZKbmbvudiHu6ScqDmz3o64ZViyy2JPcaY');
hash = hash.slice(1, 21);
var peer = new Peer(myID, addr, hash, bcoin.network.get('simnet'));
peer.connect(myID, addr, hash);
peer.on('connect', function() {
  console.log('connected');

  var ck = bcoin.ec.publicKeyCreate(bcoin.ec.generatePrivateKey(), true);
  var cp = bcoin.ec.publicKeyCreate(bcoin.ec.generatePrivateKey(), true);

  var sfr = new wire.SingleFundingRequest();
  sfr.channelID = 0;
  sfr.channelType = 0;
  sfr.coinType = 0;
  sfr.feeRate = 5000;
  sfr.fundingValue = 1000;
  sfr.csvDelay = 10;
  sfr.commitKey = ck;
  sfr.channelDerivationPoint = cp;
  sfr.deliveryScript.fromProgram(0, crypto.hash160(ck));

  peer.send(sfr);
});
