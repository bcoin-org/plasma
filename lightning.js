/*!
 * script.js - script interpreter for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('../bcoin');
var bn = require('bn.js');
var constants = bcoin.constants;
var utils = require('../bcoin/lib/utils/utils');
var assert = utils.assert;
var BufferWriter = require('../bcoin/lib/utils/writer');
var BufferReader = require('../bcoin/lib/utils/reader');
var opcodes = constants.opcodes;
var hashType = constants.hashType;
var util = {};

// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/script_utils.go
// https://github.com/ElementsProject/lightning/blob/master/bitcoin/script.c
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/channel.go
// https://github.com/lightningnetwork/lnd/blob/master/elkrem/elkrem.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/script_utils_test.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/script_utils.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/script_utils_test.go
// https://github.com/lightningnetwork/lnd/blob/master/channeldb/channel.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/channel.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwallet/channel_test.go
// https://github.com/lightningnetwork/lnd/blob/master/lnwire/htlc_addrequest.go

util.toWitnessScripthash = function(redeem) {
  return bcoin.script.fromProgram(0, redeem.sha256());
};

util.toMultisig = function(k1, k2) {
  var script = new bcoin.script();
  var k;

  // Note: It looks like lnd orders these in reverse.
  if (utils.cmp(k1, k2) < 0) {
    k = k1;
    k1 = k2;
    k2 = k;
  }

  script.push(opcodes.OP_2);
  script.push(k1);
  script.push(k2);
  script.push(opcodes.OP_2);
  script.push(opcodes.OP_CHECKMULTISIG);
  script.compile();

  // return bcoin.script.fromMultisig(2, 2, [k1, k2]);

  return script;
};

util.fundingRedeem = function(k1, k2, value) {
  var redeem = util.toMultisig(k1, k2);
  var output = new bcoin.output();

  output.script = util.toWitnessScripthash(redeem);
  output.value = value;

  assert(value > 0);

  return {
    redeem: redeem,
    output: output
  };
};

util.spendMultisig = function(redeem, k1, s1, k2, s2) {
  var witness = new bcoin.witness();

  witness.push(new Buffer(0));

  // Note: It looks like lnd orders these in reverse.
  if (utils.cmp(k1, k2) < 0) {
    witness.push(s2);
    witness.push(s1);
  } else {
    witness.push(s1);
    witness.push(s2);
  }

  witness.push(redeem.toRaw());
  witness.compile();

  return witness;
};

util.findOutput = function(tx, script) {
  var i, output;

  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    if (utils.equal(output.script.toRaw(), script.toRaw()))
      return i;
  }

  return -1;
};

util.createSenderHTLC = function(absTimeout, relTimeout, senderKey, recKey, revHash, payHash) {
  var script = new bcoin.script();
  script.push(opcodes.OP_IF);
  script.push(opcodes.OP_IF);
  script.push(revHash);
  script.push(opcodes.OP_ELSE);
  script.push(opcodes.OP_SIZE);
  script.push(new bn(32));
  script.push(opcodes.OP_EQUALVERIFY);
  script.push(payHash);
  script.push(opcodes.OP_ENDIF);
  script.push(opcodes.OP_SWAP);
  script.push(opcodes.OP_SHA256);
  script.push(opcodes.OP_EQUALVERIFY);
  script.push(recKey);
  script.push(opcodes.OP_CHECKSIG);
  script.push(opcodes.OP_ELSE);
  script.push(new bn(absTimeout));
  script.push(opcodes.OP_CHECKLOCKTIMEVERIFY);
  script.push(new bn(relTimeout));
  script.push(opcodes.OP_CHECKSEQUENCEVERIFY);
  script.push(opcodes.OP_2DROP);
  script.push(senderKey);
  script.push(opcodes.OP_CHECKSIG);
  script.push(opcodes.OP_ENDIF);
  script.compile();
  return script;
};

util.senderSpendRedeem = function(commitScript, recKey, sweep, payImage) {
  var sig = sweep.signature(0, commitScript, recKey, hashType.ALL, 1);
  var witness = new bcoin.witness();
  witness.push(sig);
  witness.push(payImage);
  witness.push(new bn(0));
  witness.push(new bn(1));
  witness.push(commitScript.toRaw());
  witness.compile();
  return witness;
};

util.senderSpendRevoke = function(commitScript, recKey, sweep, revImage) {
  var sig = sweep.signature(0, commitScript, recKey, hashType.ALL, 1);
  var witness = new bcoin.witness();
  witness.push(sig);
  witness.push(revImage);
  witness.push(new bn(1));
  witness.push(new bn(1));
  witness.push(commitScript.toRaw());
  witness.compile();
  return witness;
};

util.senderSpendTimeout = function(commitScript, senderKey, sweep, absTimeout, relTime) {
  var sig, witness;

  sweep.setSequence(0, relTime);
  sweep.setLocktime(absTimeout);

  sig = sweep.signature(0, commitScript, senderKey, hashType.ALL, 1);

  witness = new bcoin.witness();
  witness.push(sig);
  witness.push(new bn(0));
  witness.push(commitScript.toRaw());
  witness.compile();

  return witness;
};

util.createReceiverHTLC = function(absTimeout, relTimeout, senderKey, recKey, revHash, payHash) {
  var script = new bcoin.script();
  script.push(opcodes.OP_IF);
  script.push(opcodes.OP_SIZE);
  script.push(new bn(32));
  script.push(opcodes.OP_EQUALVERIFY);
  script.push(opcodes.OP_SHA256);
  script.push(payHash);
  script.push(opcodes.OP_EQUALVERIFY);
  script.push(new bn(relTimeout));
  script.push(opcodes.OP_CHECKSEQUENCEVERIFY);
  script.push(opcodes.OP_DROP);
  script.push(recKey);
  script.push(opcodes.OP_CHECKSIG);
  script.push(opcodes.OP_ELSE);
  script.push(opcodes.OP_IF);
  script.push(opcodes.OP_SHA256);
  script.push(revHash);
  script.push(opcodes.OP_EQUALVERIFY);
  script.push(opcodes.OP_ELSE);
  script.push(new bn(absTimeout));
  script.push(opcodes.OP_CHECKLOCKTIMEVERIFY);
  script.push(opcodes.OP_DROP);
  script.push(opcodes.OP_ENDIF);
  script.push(senderKey);
  script.push(opcodes.OP_CHECKSIG);
  script.push(opcodes.OP_ENDIF);
  script.compile();
  return script;
};

util.recSpendRedeem = function(commitScript, recKey, sweep, payImage, relTime) {
  var sig, witness;

  sweep.setSequence(0, relTime);

  sig = sweep.signature(0, commitScript, recKey, hashType.ALL, 1);

  witness = new bcoin.witness();
  witness.push(sig);
  witness.push(payImage);
  witness.push(new bn(1));
  witness.push(commitScript.toRaw());
  witness.compile();

  return witness;
};

util.recSpendRevoke = function(commitScript, senderKey, sweep, revImage) {
  var sig = sweep.signature(0, commitScript, senderKey, hashType.ALL, 1);
  var witness = new bcoin.witness();
  witness.push(sig);
  witness.push(revImage);
  witness.push(new bn(1));
  witness.push(new bn(0));
  witness.push(commitScript.toRaw());
  witness.compile();
  return witness;
};

util.recSpendTimeout = function(commitScript, senderKey, sweep, absTimeout) {
  var sig, witness;

  sweep.setLocktime(absTimeout);

  sig = sweep.signature(0, commitScript, senderKey, hashType.ALL, 1);

  witness = new bcoin.witness();
  witness.push(sig);
  witness.push(new bn(0));
  witness.push(new bn(0));
  witness.push(commitScript.toRaw());
  witness.compile();

  return witness;
};

util.commitSelf = function commitSelf(csvTime, selfKey, revKey) {
  var script = new bcoin.script();
  script.push(opcodes.OP_IF);
  script.push(revKey);
  script.push(opcodes.OP_CHECKSIG);
  script.push(opcodes.OP_ELSE);
  script.push(selfKey);
  script.push(opcodes.OP_CHECKSIGVERIFY);
  script.push(new bn(csvTime));
  script.push(opcodes.OP_CHECKSEQUENCEVERIFY);
  script.push(opcodes.OP_ENDIF);
  script.compile();
  return script;
};

util.commitUnencumbered = function commitUnencumbered(key) {
  return bcoin.script.fromProgram(0, utils.hash160(key));
};

util.commitSpendTimeout = function commitSpendTimeout(commitScript, blockTimeout, selfKey, sweep) {
  var sig, witness;

  sweep.setSequence(0, blockTimeout);

  sig = sweep.signature(0, commitScript, selfKey, hashType.ALL, 1);
  witness = new bcoin.witness();
  witness.push(sig);
  witness.push(new bn(0));
  witness.push(commitScript.toRaw());
  witness.compile();

  return witness;
};

util.commitSpendRevoke = function commitSpendRevoke(commitScript, revPriv, sweep) {
  var sig = sweep.signature(0, commitScript, revPriv, hashType.ALL, 1);
  var witness = new bcoin.witness();
  witness.push(sig);
  witness.push(new bn(1));
  witness.push(commitScript.toRaw());
  witness.compile();
  return witness;
};

util.commitSpendNoDelay = function commitSpendNoDelay(commitScript, commitPriv, sweep) {
  var pkh = bcoin.script.fromPubkeyhash(commitScript.get(1));
  var sig = sweep.signature(0, pkh, commitPriv, hashType.ALL, 1);
  var witness = new bcoin.witness();
  witness.push(sig);
  witness.push(bcoin.ec.publicKeyCreate(commitPriv, true));
  witness.compile();
  return witness;
};

util.deriveRevPub = function(commitPub, revImage) {
  return bcoin.ec.publicKeyTweakAdd(commitPub, revImage, true);
};

util.deriveRevPriv = function(commitPriv, revImage) {
  return bcoin.ec.privateKeyTweakAdd(commitPriv, revImage);
};

util.deriveElkremRoot = function(localKey, remoteKey) {
  var secret = localKey; // private
  var salt = remoteKey; // public
  var info = new Buffer('elkrem', 'ascii');
  var prk = utils.hkdfExtract(secret, salt, 'sha256');
  var root = utils.hkdfExpand(prk, info, 32, 'sha256');
  return root;
};

util.createCommitTX = function(
  fundingOutput, selfKey, theirKey, revKey,
  csvTimeout, valueToSelf, valueToThem
) {
  var ourRedeem = util.commitSelf(csvTimeout, selfKey, revKey);
  var payToUs = util.toWitnessScripthash(ourRedeem);
  var payToThem = util.commitUnencumbered(theirKey);
  var tx = new bcoin.mtx();
  var output;

  tx.version = 2;
  tx.addInput(fundingOutput);

  if (valueToSelf > 0) {
    output = new bcoin.output();
    output.value = valueToSelf;
    output.script = payToUs;
    tx.addOutput(output);
  }

  if (valueToThem > 0) {
    output = new bcoin.output();
    output.value = valueToThem;
    output.script = payToThem;
    tx.addOutput(output);
  }

  return tx;
};

util.createCooperativeClose = function createCooperativeClose(
  fundingInput, ourBalance, theirBalance,
  ourDeliveryScript, theirDeliveryScript,
  initiator
) {
  var tx = new bcoin.mtx();
  var output;

  tx.addInput(fundingInput);

  if (initiator)
    ourBalance -= 5000;
  else
    theirBalance -= 5000;

  if (ourBalance > 0) {
    output = new bcoin.output();
    output.script = ourDeliveryScript;
    output.value = ourBalance;
    tx.addOutput(output);
  }

  if (theirBalance > 0) {
    output = new bcoin.output();
    output.script = theirDeliveryScript;
    output.value = theirBalance;
    tx.addOutput(output);
  }

  tx.sortMembers();

  return tx;
};

function leftHash(hash) {
  return utils.hash256(hash);
}

function rightHash(hash) {
  var buf = new Buffer(33);
  hash.copy(buf, 0);
  buf[32] = 1;
  return utils.hash256(buf);
}

function descend(w, i, h, hash) {
  var pow;

  while (w < i) {
    pow = Math.pow(2, h);

    if (w <= i - pow) {
      hash = leftHash(hash);
      i -= pow;
    } else {
      hash = rightHash(hash);
      i--;
    }

    if (h === 0)
      break;

    h--;
  }

  if (w !== i)
    throw new Error('Cannot get index ' + w + ' from ' + i);

  return hash;
}

var maxIndex = 281474976710654; // 2^48 - 2
var maxHeight = 47;

function ElkremSender(root) {
  this.root = root;
}

ElkremSender.prototype.getIndex = function getIndex(w) {
  return descend(w, maxIndex, maxHeight, this.root);
};

function ElkremNode(hash, h, i) {
  this.hash = hash || constants.ZERO_HASH;
  this.h = h || 0;
  this.i = i || 0;
}

function ElkremReceiver(stack) {
  this.stack = stack || [];
}

ElkremReceiver.prototype.addNext = function addNext(hash) {
  var node = new ElkremNode(hash);
  var t = this.stack.length - 1;
  var left, right;

  if (t >= 0)
    node.i = this.stack[t].i + 1;

  if (t > 0 && this.stack[t - 1].h === this.stack[t].h) {
    node.h = this.stack[t].h + 1;

    left = leftHash(hash);
    right = rightHash(hash);

    if (!utils.equal(this.stack[t - 1].hash, left))
      throw new Error('Left child does not match.');

    if (!utils.equal(this.stack[t].hash, right))
      throw new Error('Right child does not match.');

    this.stack.pop();
    this.stack.pop();
  }

  this.stack.push(node);
};

ElkremReceiver.prototype.getIndex = function getIndex(w) {
  var i, node, out;

  if (this.stack.length === 0)
    throw new Error('Nil receiver');

  for (i = 0; i < this.stack.length; i++) {
    node = this.stack[i];
    if (w <= node.i) {
      out = node;
      break;
    }
  }

  if (!out) {
    throw new Error('Receiver has max '
      + this.stack[this.stack.length - 1].i
      + ', less than requested ' + w);
  }

  return descend(w, out.i, out.h, out.hash);
};

ElkremReceiver.prototype.upTo = function upTo() {
  if (this.stack.length < 1)
    return 0;
  return this.stack[this.stack.length - 1].i;
};

var maxPendingPayments = 100;
var initialRevocationWindow = 4;

var channelStates = {
  PENDING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
  DISPUTE: 4,
  PENDINGPAYMENT: 5
};

var updateType = {
  ADD: 0,
  TIMEOUT: 1,
  SETTLE: 2
};

function PaymentDescriptor() {
  this.paymentHash = constants.ZERO_HASH;
  this.timeout = 0;
  this.value = 0;
  this.index = 0;
  this.parentIndex = 0;
  this.payload = null;
  this.entryType = updateType.ADD;
  this.addCommitHeightRemote = 0;
  this.addCommitHeightLocal = 0;
  this.removeCommitHeightRemote = 0;
  this.removeCommitHeightLocal = 0;
  this.isForwarded = false;
  this.settled = false;
}

function Commitment() {
  this.height = 0;
  this.ourMessageIndex = 0;
  this.theirMessageIndex = 0;
  this.tx = new bcoin.mtx();
  this.sig = constants.ZERO_SIG;
  this.ourBalance = 0;
  this.theirBalance = 0;
}

function CommitmentChain(height) {
  this.list = new List();
  this.startingHeight = height || 0;
}

CommitmentChain.prototype.add = function(c) {
  this.list.push(c);
};

CommitmentChain.prototype.advanceTail = function() {
  this.list.shift();
};

CommitmentChain.prototype.tip = function() {
  if (!this.list.tail)
    return;
  return this.list.tail.value;
};

CommitmentChain.prototype.tail = function() {
  if (!this.list.head)
    return;
  return this.list.head.value;
};

function HTLCView(ourUpdates, theirUpdates) {
  this.ourUpdates = ourUpdates || [];
  this.theirUpdates = theirUpdates || [];
  this.ourBalance = 0;
  this.theirBalance = 0;
}

function Channel(options) {
  this.wallet = options.wallet || null;
  this.chain = options.chain || null;
  this.ourLogCounter = 0;
  this.theirLogCounter = 0;
  this.status = channelStates.PENDING;
  this.currentHeight = options.state.numUpdates || 0;
  this.revocationWindowEdge = options.state.numUpdates || 0;
  this.usedRevocations = [];
  this.revocationWindow = [];
  this.remoteCommitChain = new CommitmentChain();
  this.localCommitChain = new CommitmentChain();
  this.state = options.state;
  this.ourUpdateLog = new List();
  this.theirUpdateLog = new List();
  this.ourLogIndex = {};
  this.theirLogIndex = {};
  this.fundingInput = new bcoin.coin();
  this.fundingInput.version = 1;
  this.fundingP2WSH = null;
  this.db = options.db || null;
  this.started = 0;
  this.shutdown = 0;

  this._init();
}

Channel.prototype._init = function _init() {
  var initialCommit = new Commitment();
  var fundingScript;

  initialCommit.height = this.currentHeight;
  initialCommit.ourBalance = this.state.ourBalance;
  initialCommit.theirBalance = this.state.theirBalance;

  this.localCommitChain.add(initialCommit);
  this.remoteCommitChain.add(initialCommit);

  fundingScript = util.toWitnessScripthash(this.state.fundingScript);

  this.fundingInput.hash = this.state.fundingInput.hash;
  this.fundingInput.index = this.state.fundingInput.index;
  this.fundingInput.script = fundingScript;
  this.fundingP2WSH = fundingScript;
};

Channel.prototype.getCommitmentView = getCommitmentView;

function getCommitmentView(ourLogIndex, theirLogIndex, revKey, revHash, remoteChain) {
  var commitChain, ourBalance, theirBalance, nextHeight;
  var view, filtered;
  var selfKey, remoteKey, delay, delayBalance, p2wpkhBalance;
  var i, ourCommit, commit, htlc, commitment;

  if (remoteChain)
    commitChain = this.remoteCommitChain;
  else
    commitChain = this.localCommitChain;

  if (!commitChain.tip()) {
    ourBalance = this.state.ourBalance;
    theirBalance = this.state.theirBalance;
    nextHeight = 1;
  } else {
    ourBalance = commitChain.tip().ourBalance;
    theirBalance = commitChain.tip().theirBalance;
    nextHeight = commitChain.tip().height + 1;
  }

  view = this.getHTLCView(theirLogIndex, ourLogIndex);

  filtered = this.evalHTLCView(
    view, ourBalance, theirBalance,
    nextHeight, remoteChain);

  if (remoteChain) {
    selfKey = this.state.theirCommitKey;
    remoteKey = bcoin.ec.publicKeyCreate(this.state.ourCommitKey, true);
    delay = this.state.remoteCSVDelay;
    delayBalance = filtered.theirBalance;
    p2wpkhBalance = filtered.ourBalance;
  } else {
    selfKey = bcoin.ec.publicKeyCreate(this.state.ourCommitKey, true);
    remoteKey = this.state.theirCommitKey;
    delay = this.state.localCSVDelay;
    delayBalance = filtered.ourBalance;
    p2wpkhBalance = filtered.theirBalance;
  }

  ourCommit = !remoteChain;

  commit = util.createCommitTX(
    this.fundingInput, selfKey, remoteKey,
    revKey, delay, delayBalance, p2wpkhBalance);

  for (i = 0; i < filtered.ourUpdates.length; i++) {
    htlc = filtered.ourUpdates[i];
    this.pushHTLC(commit, ourCommit, htlc, revHash, delay, false);
  }

  for (i = 0; i < filtered.theirUpdates.length; i++) {
    htlc = filtered.theirUpdates[i];
    this.pushHTLC(commit, ourCommit, htlc, revHash, delay, true);
  }

  commit.sortMembers();

  commitment = new Commitment();
  commitment.tx = commit;
  commitment.height = nextHeight;
  commitment.ourBalance = filtered.ourBalance;
  commitment.ourMessageIndex = ourLogIndex;
  commitment.theirMessageIndex = theirLogIndex;
  commitment.theirBalance = filtered.theirBalance;

  return commitment;
}

Channel.prototype.getHTLCView = function getHTLCView(theirLogIndex, ourLogIndex) {
  var ours = [];
  var theirs = [];
  var item, htlc;

  for (item = this.ourUpdateLog.head; item; item = item.next) {
    htlc = item.value;
    if (htlc.index < ourLogIndex)
      ours.push(htlc);
  }

  for (item = this.theirUpdateLog.head; item; item = item.next) {
    htlc = item.value;
    if (htlc.index < theirLogIndex)
      theirs.push(htlc);
  }

  return new HTLCView(ours, theirs);
};

Channel.prototype.evalHTLCView = evalHTLCView;

function evalHTLCView(view, ourBalance, theirBalance, nextHeight, remoteChain) {
  var filtered = new HTLCView();
  var skipUs = {};
  var skipThem = {};
  var i, entry, addEntry, isAdd;

  filtered.ourBalance = ourBalance;
  filtered.theirBalance = theirBalance;

  for (i = 0; i < view.ourUpdates.length; i++) {
    entry = view.ourUpdates[i];
    if (entry.entryType === updateType.ADD)
      continue;
    addEntry = this.theirLogIndex[entry.parentIndex];
    skipThem[addEntry.value.index] = true;
    processRemoveEntry(entry, filtered, nextHeight, remoteChain, true);
  }

  for (i = 0; i < view.theirUpdates.length; i++) {
    entry = view.theirUpdates[i];
    if (entry.entryType === updateType.ADD)
      continue;
    addEntry = this.ourLogIndex[entry.parentIndex];
    skipUs[addEntry.value.index] = true;
    processRemoveEntry(entry, filtered, nextHeight, remoteChain, false);
  }

  for (i = 0; i < view.ourUpdates.length; i++) {
    entry = view.ourUpdates[i];
    isAdd = entry.entryType === updateType.ADD;
    if (!isAdd || skipUs[entry.index])
      continue;
    processAddEntry(entry, filtered, nextHeight, remoteChain, false);
    filtered.ourUpdates.push(entry);
  }

  for (i = 0; i < view.theirUpdates.length; i++) {
    entry = view.theirUpdates[i];
    isAdd = entry.entryType === updateType.ADD;
    if (!isAdd || skipThem[entry.index])
      continue;
    processAddEntry(entry, filtered, nextHeight, remoteChain, true);
    filtered.theirUpdates.push(entry);
  }

  return filtered;
}

function processAddEntry(htlc, filtered, nextHeight, remoteChain, isIncoming) {
  var addHeight;

  if (remoteChain)
    addHeight = htlc.addCommitHeightRemote;
  else
    addHeight = htlc.addCommitHeightLocal;

  if (addHeight !== 0)
    return;

  if (isIncoming)
    filtered.theirBalance -= htlc.value;
  else
    filtered.ourBalance -= htlc.value;

  if (remoteChain)
    htlc.addCommitHeightRemote = nextHeight;
  else
    htlc.addCommitHeightLocal = nextHeight;
}

function processRemoveEntry(htlc, filtered, nextHeight, remoteChain, isIncoming) {
  var removeHeight;

  if (remoteChain)
    removeHeight = htlc.removeCommitHeightRemote;
  else
    removeHeight = htlc.removeCommitHeightLocal;

  if (removeHeight !== 0)
    return;

  if (isIncoming) {
    if (htlc.entryType === updateType.SETTLE)
      filtered.ourBalance += htlc.value;
    else if (htlc.entryType === updateType.TIMEOUT)
      filtered.theirBalance += htlc.value;
  } else {
    if (htlc.entryType === updateType.SETTLE)
      filtered.theirBalance += htlc.value;
    else if (htlc.entryType === updateType.TIMEOUT)
      filtered.ourBalance += htlc.value;
  }

  if (remoteChain)
    htlc.removeCommitHeightRemote = nextHeight;
  else
    htlc.removeCommitHeightLocal = nextHeight;
}

Channel.prototype.signNextCommitment = function signNextCommitment() {
  var nextRev, remoteRevKey, remoteRevHash, view, sig;

  if (this.revocationWindow.length === 0
      || this.usedRevocations.length === initialRevocationWindow) {
    throw new Error('No revocation window.');
  }

  nextRev = this.revocationWindow[0];
  remoteRevKey = nextRev.nextRevKey;
  remoteRevHash = nextRev.nextRevHash;

  view = this.getCommitmentView(
    this.ourLogCounter, this.theirLogCounter,
    remoteRevKey, remoteRevHash, true);

  view.tx.inputs[0].coin.value = this.state.capacity;

  sig = view.tx.signature(0,
    this.state.fundingScript,
    this.state.ourMultisigKey,
    hashType.ALL,
    1);

  this.remoteCommitChain.add(view);

  this.usedRevocations.push(nextRev);
  this.revocationWindow.shift();

  return {
    sig: sig.slice(0, -1),
    index: this.theirLogCounter
  };
};

Channel.prototype.receiveNewCommitment = function receiveNewCommitment(sig, ourLogIndex) {
  var theirCommitKey = this.state.theirCommitKey;
  var theirMultisigKey = this.state.theirMultisigKey;
  var nextHeight = this.currentHeight + 1;
  var revocation = this.state.localElkrem.getIndex(nextHeight);
  var revKey = util.deriveRevPub(theirCommitKey, revocation);
  var revHash = utils.sha256(revocation);
  var view, localCommit, multisigScript;
  var msg, result;

  view = this.getCommitmentView(
    ourLogIndex, this.theirLogCounter,
    revKey, revHash, false);

  localCommit = view.tx;
  multisigScript = this.state.fundingScript;

  localCommit.inputs[0].coin.value = this.state.capacity;

  msg = localCommit.signatureHash(0, multisigScript, hashType.ALL, 1);
  result = bcoin.ec.verify(msg, sig, theirMultisigKey);

  if (!result)
    throw new Error('Invalid commitment signature.');

  view.sig = sig;

  this.localCommitChain.add(view);
};

Channel.prototype.pendingUpdates = function pendingUpdates() {
  var localTip = this.localCommitChain.tip();
  var remoteTip = this.remoteCommitChain.tip();
  return localTip.ourMessageIndex !== remoteTip.ourMessageIndex;
};

Channel.prototype.revokeCurrentCommitment = function revokeCurrentCommitment() {
  var theirCommitKey = this.state.theirCommitKey;
  var revMsg = new CommitRevocation();
  var currentRev, revEdge, tail;

  revMsg.channelPoint = this.state.id;

  currentRev = this.state.localElkrem.getIndex(this.currentHeight);
  revMsg.revocation = currentRev;

  this.revocationWindowEdge++;

  revEdge = this.state.localElkrem.getIndex(this.revocationWindowEdge);
  revMsg.nextRevKey = util.deriveRevPub(theirCommitKey, revEdge);
  revMsg.nextRevHash = utils.sha256(revEdge);

  this.localCommitChain.advanceTail();
  this.currentHeight++;

  tail = this.localCommitChain.tail();
  this.state.ourCommitTX = tail.tx;
  this.state.ourBalance = tail.ourBalance;
  this.state.theirBalance = tail.theirBalance;
  this.state.ourCommitSig = tail.sig;
  this.state.numUpdates++;

  this.state.fullSync();

  return revMsg;
};

Channel.prototype.receiveRevocation = function receiveRevocation(revMsg) {
  var ourCommitKey, currentRevKey, pendingRev, remoteElkrem;
  var revPriv, revPub, revHash, nextRev;
  var remoteChainTail, localChainTail;
  var item, htlcsToForward, htlc, uncommitted;

  if (utils.equal(revMsg.revocation, constants.ZERO_HASH)) {
    this.revocationWindow.push(revMsg);
    return;
  }

  ourCommitKey = this.state.ourCommitKey;
  currentRevKey = this.state.theirCurrentRevocation;
  pendingRev = revMsg.revocation;
  remoteElkrem = this.state.remoteElkrem;

  remoteElkrem.addNext(pendingRev);

  revPriv = util.deriveRevPriv(ourCommitKey, pendingRev);
  revPub = bcoin.ec.publicKeyCreate(revPriv, true);

  if (!utils.equal(revPub, currentRevKey))
    throw new Error('Revocation key mistmatch.');

  if (!utils.equal(this.state.theirCurrentRevHash, constants.ZERO_HASH)) {
    revHash = utils.sha256(pendingRev);
    if (!utils.equal(this.state.theirCurrentRevHash, revHash))
      throw new Error('Revocation hash mismatch.');
  }

  nextRev = this.usedRevocations[0];

  this.state.theirCurrentRevocation = nextRev.nextRevKey;
  this.state.theirCurrentRevHash = nextRev.nextRevHash;
  this.usedRevocations.shift();
  this.revocationWindow.push(revMsg);

  this.state.syncRevocation();
  this.remoteCommitChain.advanceTail();

  remoteChainTail = this.remoteCommitChain.tail().height;
  localChainTail = this.localCommitChain.tail().height;

  htlcsToForward = [];

  for (item = this.theirUpdateLog.head; item; item = item.next) {
    htlc = item.value;

    if (htlc.isForwarded)
      continue;

    uncommitted = htlc.addCommitHeightRemote === 0
      || htlc.addCommitHeightLocal === 0;

    if (htlc.entryType === updateType.ADD && uncommitted)
      continue;

    if (htlc.entryType === updateType.ADD
        && remoteChainTail >= htlc.addCommitHeightRemote
        && localChainTail >= htlc.addCommitHeightLocal) {
      htlc.isForwarded = true;
      htlcsToForward.push(htlc);
      continue;
    }

    if (htlc.entryType !== updateType.ADD
      && remoteChainTail >= htlc.removeCommitHeightRemote
      && localChainTail >= htlc.removeCommitHeightLocal) {
      htlc.isForwarded = true;
      htlcsToForward.push(htlc);
    }
  }

  this.compactLogs(
    this.ourUpdateLog, this.theirUpdateLog,
    localChainTail, remoteChainTail);

  return htlcsToForward;
};

Channel.prototype.compactLogs = compactLogs;

function compactLogs(ourLog, theirLog, localChainTail, remoteChainTail) {
  function compact(logA, logB, indexB, indexA) {
    var removeA = [];
    var removeB = [];
    var item, next, j, htlc, parentLink, parentIndex;

    for (item = logA.head; item; item = next) {
      htlc = item.value;
      next = item.next;

      if (htlc.entryType === updateType.ADD)
        continue;

      if (htlc.removeCommitHeightRemote === 0
          || htlc.removeCommitHeightLocal === 0) {
        continue;
      }

      if (remoteChainTail >= htlc.removeCommitHeightRemote
          && localChainTail >= htlc.removeCommitHeightLocal) {
        parentLink = indexB[htlc.parentIndex];
        assert(htlc.parentIndex === parentLink.value.index);
        parentIndex = parentLink.value.index;
        logB.removeItem(parentLink);
        logA.removeItem(item);
        delete indexB[parentIndex];
        delete indexA[htlc.index];
      }
    }
  }

  compact(ourLog, theirLog, this.theirLogIndex, this.ourLogIndex);
  compact(theirLog, ourLog, this.ourLogIndex, this.theirLogIndex);
};

function CommitRevocation() {
  this.channelPoint = new bcoin.outpoint();
  this.revocation = constants.ZERO_HASH;
  this.nextRevKey = constants.ZERO_KEY;
  this.nextRevHash = constants.ZERO_HASH;
}

function HTLCAddRequest() {
  this.channelPoint = new bcoin.outpoint();
  this.expiry = 0;
  this.value = 0;
  this.refundContext = null; // not currently used
  this.contractType = 0; // bitfield for m of n
  this.redemptionHashes = [];
  this.onionBlob = null;
}

Channel.prototype.extendRevocationWindow = function extendRevocationWindow() {
  var revMsg = new CommitRevocation();
  var nextHeight = this.revocationWindowEdge + 1;
  var revocation = this.state.localElkrem.getIndex(nextHeight);
  var theirCommitKey = this.state.theirCommitKey;

  revMsg.channelPoint = this.state.id;
  revMsg.nextRevKey = util.deriveRevPub(theirCommitKey, revocation);
  revMsg.nextRevHash = utils.sha256(revocation);

  this.revocationWindowEdge++;

  return revMsg;
};

Channel.prototype.addHTLC = function addHTLC(htlc) {
  var pd = new PaymentDescriptor();
  var item;

  pd.entryType = updateType.ADD;
  pd.paymentHash = htlc.redemptionHashes[0];
  pd.timeout = htlc.expiry;
  pd.value = htlc.value;
  pd.index = this.ourLogCounter;

  item = this.ourUpdateLog.push(pd);
  this.ourLogIndex[pd.index] = item;
  this.ourLogCounter++;

  return pd.index;
};

Channel.prototype.receiveHTLC = function receiveHTLC(htlc) {
  var pd = new PaymentDescriptor();
  var item;

  pd.entryType = updateType.ADD;
  pd.paymentHash = htlc.redemptionHashes[0];
  pd.timeout = htlc.expiry;
  pd.value = htlc.value;
  pd.index = this.theirLogCounter;

  item = this.theirUpdateLog.push(pd);
  this.theirLogIndex[pd.index] = item;
  this.theirLogCounter++;

  return pd.index;
};

Channel.prototype.settleHTLC = function settleHTLC(preimage) {
  var paymentHash = utils.sha256(preimage);
  var item, htlc, parentPd, pd, targetHTLC;

  for (item = this.theirUpdateLog.head; item; item = item.next) {
    htlc = item.value;

    if (htlc.entryType !== updateType.ADD)
      continue;

    if (!htlc.settled && utils.equal(htlc.paymentHash, paymentHash)) {
      htlc.settled = true;
      targetHTLC = htlc;
      break;
    }
  }

  if (!targetHTLC)
    throw new Error('Invalid payment hash.');

  parentPd = targetHTLC;

  pd = new PaymentDescriptor();
  pd.value = parentPd.value;
  pd.index = this.ourLogCounter;
  pd.parentIndex = parentPd.index;
  pd.entryType = updateType.SETTLE;

  this.ourUpdateLog.push(pd);
  this.ourLogCounter++;

  return parentPd.index;
};

Channel.prototype.receiveHTLCSettle = function receiveHTLCSettle(preimage, logIndex) {
  var paymentHash = utils.sha256(preimage);
  var addEntry = this.ourLogIndex[logIndex];
  var htlc, pd;

  if (!addEntry)
    throw new Error('Non existent log entry.');

  htlc = addEntry.value;

  if (!utils.equal(htlc.paymentHash, paymentHash))
    throw new Error('Invalid payment hash.');

  pd = new PaymentDescriptor();
  pd.value = htlc.value;
  pd.parentIndex = htlc.index;
  pd.index = this.theirLogCounter;
  pd.entryType = updateType.SETTLE;

  this.theirUpdateLog.push(pd);
  this.theirLogCounter++;
};

Channel.prototype.channelPoint = function channelPoint() {
  return this.state.id;
};

Channel.prototype.pushHTLC = pushHTLC;

function pushHTLC(commitTX, ourCommit, pd, revocation, delay, isIncoming) {
  var localKey = bcoin.ec.publicKeyCreate(this.state.ourCommitKey, true);
  var remoteKey = this.state.theirCommitKey;
  var timeout = pd.timeout;
  var payHash = pd.paymentHash;
  var script, htlcHash, valuePending, output;

  if (isIncoming) {
    if (ourCommit) {
      script = util.createReceiverHTLC(
        timeout, delay, remoteKey,
        localKey, revocation, payHash);
    } else {
      script = util.createSenderHTLC(
        timeout, delay, remoteKey,
        localKey, revocation, payHash);
    }
  } else {
    if (ourCommit) {
      script = util.createSenderHTLC(
        timeout, delay, localKey,
        remoteKey, revocation, payHash);
    } else {
      script = util.createReceiverHTLC(
        timeout, delay, localKey,
        remoteKey, revocation, payHash);
    }
  }

  htlcHash = util.toWitnessScripthash(script);
  valuePending = pd.value;

  output = new bcoin.output();
  output.script = htlcHash;
  output.value = valuePending;

  commitTX.addOutput(output);
}

Channel.prototype.forceClose = function forceClose() {
};

Channel.prototype.initCooperativeClose = function initCooperativeClose() {
  var closeTX, sig;

  if (this.status === channelStates.CLOSING
      || this.status === channelStates.CLOSED) {
    throw new Error('Channel is already closed.');
  }

  this.status = channelStates.CLOSING;

  closeTX = util.createCooperativeClose(
    this.fundingInput,
    this.state.ourBalance,
    this.state.theirBalance,
    this.state.ourDeliveryScript,
    this.state.theirDeliveryScript,
    true);

  closeTX.inputs[0].coin.value = this.state.capacity;

  sig = closeTX.signature(0,
    this.state.fundingScript,
    this.state.ourMultisigKey,
    hashType.ALL, 1);

  return {
    sig: sig,
    hash: closeTX.hash()
  };
};

Channel.prototype.completeCooperativeClose = function completeCooperativeClose(remoteSig) {
  var closeTX, redeem, sig, ourKey, theirKey, witness;

  if (this.status === channelStates.CLOSING
      || this.status === channelStates.CLOSED) {
    throw new Error('Channel is already closed.');
  }

  this.status = channelStates.CLOSED;

  closeTX = util.createCooperativeClose(
    this.fundingInput,
    this.state.ourBalance,
    this.state.theirBalance,
    this.state.ourDeliveryScript,
    this.state.theirDeliveryScript,
    false);

  closeTX.inputs[0].coin.value = this.state.capacity;

  redeem = this.state.fundingScript;
  sig = closeTX.signature(0,
    redeem, this.state.ourMultisigKey,
    hashType.ALL, 1);

  ourKey = bcoin.ec.publicKeyCreate(this.state.ourMultisigKey, true);
  theirKey = this.state.theirMultisigKey;
  witness = util.spendMultisig(redeem, ourKey, sig, theirKey, remoteSig);

  closeTX.inputs[0].witness = witness;

  if (!closeTX.verify())
    throw new Error('TX did not verify.');

  return closeTX;
};

function ChannelState(options) {
  this.theirLNID = null;
  this.id = new bcoin.outpoint();
  this.minRate = 0;
  this.ourCommitKey = null; // private
  this.theirCommitKey = null; // public
  this.capacity = 0;
  this.ourBalance = 0;
  this.theirBalance = 0;
  this.ourCommitTX = null;
  this.ourCommitSig = null;
  this.fundingInput = new bcoin.coin();
  this.ourMultisigKey = null; // private
  this.theirMultisigKey = null; // public
  this.fundingScript = new bcoin.script();
  this.localCSVDelay = 0;
  this.remoteCSVDelay = 0;
  this.theirCurrentRevocation = constants.ZERO_KEY; // public
  this.theirCurrentRevHash = constants.ZERO_HASH;
  this.localElkrem = new ElkremSender();
  this.remoteElkrem = new ElkremReceiver();
  this.ourDeliveryScript = new bcoin.script();
  this.theirDeliveryScript = new bcoin.script();
  this.numUpdates = 0;
  this.totalSent = 0;
  this.totalReceived = 0;
  this.totalFees = 0;
  this.ts = 0;
  this.isPrevState = false;
  this.db = null;

  if (options)
    this.fromOptions(options);
}

ChannelState.prototype.fromOptions = function(options) {
  if (options.id)
    this.id = options.id;

  if (options.ourCommitKey)
    this.ourCommitKey = options.ourCommitKey;

  if (options.theirCommitKey)
    this.theirCommitKey = options.theirCommitKey;

  if (options.capacity != null)
    this.capacity = options.capacity;

  if (options.ourBalance != null)
    this.ourBalance = options.ourBalance;

  if (options.theirBalance != null)
    this.theirBalance = options.theirBalance;

  if (options.ourCommitTX)
    this.ourCommitTX = options.ourCommitTX;

  if (options.ourCommitSig)
    this.ourCommitSig = options.ourCommitSig;

  if (options.fundingInput)
    this.fundingInput = options.fundingInput;

  if (options.ourMultisigKey)
    this.ourMultisigKey = options.ourMultisigKey;

  if (options.theirMultisigKey)
    this.theirMultisigKey = options.theirMultisigKey;

  if (options.fundingScript)
    this.fundingScript = options.fundingScript;

  if (options.localCSVDelay != null)
    this.localCSVDelay = options.localCSVDelay;

  if (options.remoteCSVDelay != null)
    this.remoteCSVDelay = options.remoteCSVDelay;

  if (options.theirCurrentRevocation)
    this.theirCurrentRevocation = options.theirCurrentRevocation;

  if (options.theirCurrentRevHash)
    this.theirCurrentRevHash = options.theirCurrentRevHash;

  if (options.localElkrem)
    this.localElkrem = options.localElkrem;

  if (options.remoteElkrem)
    this.remoteElkrem = options.remoteElkrem;

  if (options.ourDeliveryScript)
    this.ourDeliveryScript = options.ourDeliveryScript;

  if (options.theirDeliveryScript)
    this.theirDeliveryScript = options.theirDeliveryScript;

  if (options.numUpdates != null)
    this.numUpdates = options.numUpdates;

  if (options.db)
    this.db = options.db;
};

ChannelState.prototype.fullSync = function() {
};

ChannelState.prototype.syncRevocation = function() {
};

/**
 * A linked list.
 * @exports List
 * @constructor
 */

function List() {
  if (!(this instanceof List))
    return new List();

  this.head = null;
  this.tail = null;
}

/**
 * Reset the cache. Clear all items.
 */

List.prototype.reset = function reset() {
  var item, next;

  for (item = this.head; item; item = next) {
    next = item.next;
    item.prev = null;
    item.next = null;
  }

  assert(!item);

  this.head = null;
  this.tail = null;
};

/**
 * Remove the first item in the list.
 */

List.prototype.shiftItem = function shiftItem() {
  var item = this.head;

  if (!item)
    return;

  this.removeItem(item);

  return item;
};

/**
 * Prepend an item to the linked list (sets new head).
 * @private
 * @param {ListItem}
 */

List.prototype.unshiftItem = function unshiftItem(item) {
  this.insertItem(null, item);
};

/**
 * Append an item to the linked list (sets new tail).
 * @private
 * @param {ListItem}
 */

List.prototype.pushItem = function pushItem(item) {
  this.insertItem(this.tail, item);
};

/**
 * Remove the last item in the list.
 */

List.prototype.popItem = function popItem() {
  var item = this.tail;

  if (!item)
    return;

  this.removeItem(item);

  return item;
};

/**
 * Remove the first item in the list.
 */

List.prototype.shift = function shift() {
  var item = this.shiftItem();
  if (!item)
    return;
  return item.value;
};

/**
 * Prepend an item to the linked list (sets new head).
 * @private
 * @param {ListItem}
 */

List.prototype.unshift = function unshift(value) {
  var item = new ListItem(value);
  this.unshiftItem(item);
  return item;
};

/**
 * Append an item to the linked list (sets new tail).
 * @private
 * @param {ListItem}
 */

List.prototype.push = function push(value) {
  var item = new ListItem(value);
  this.pushItem(item);
  return item;
};

/**
 * Remove the last item in the list.
 */

List.prototype.pop = function pop() {
  var item = this.popItem();
  if (!item)
    return;
  return item.value;
};

/**
 * Insert item into the linked list.
 * @private
 * @param {ListItem|null} ref
 * @param {ListItem} item
 */

List.prototype.insertItem = function insertItem(ref, item) {
  assert(!item.next);
  assert(!item.prev);

  if (ref == null) {
    if (!this.head) {
      this.head = item;
      this.tail = item;
    } else {
      this.head.prev = item;
      item.next = this.head;
      this.head = item;
    }
    return;
  }

  item.next = ref.next;
  item.prev = ref;
  ref.next = item;

  if (ref === this.tail)
    this.tail = item;
};

/**
 * Remove item from the linked list.
 * @private
 * @param {ListItem}
 */

List.prototype.removeItem = function removeItem(item) {
  if (item.prev)
    item.prev.next = item.next;

  if (item.next)
    item.next.prev = item.prev;

  if (item === this.head)
    this.head = item.next;

  if (item === this.tail)
    this.tail = item.prev || this.head;

  if (!this.head)
    assert(!this.tail);

  if (!this.tail)
    assert(!this.head);

  item.prev = null;
  item.next = null;
};

/**
 * Convert the list to an array of items.
 * @returns {Object[]}
 */

List.prototype.toArray = function toArray() {
  var items = [];
  var item;

  for (item = this.head; item; item = item.next)
    items.push(item.value);

  return items;
};

/**
 * Get the list size.
 * @returns {Number}
 */

List.prototype.size = function size() {
  var total = 0;
  var item;

  for (item = this.head; item; item = item.next)
    total += 1;

  return total;
};

/**
 * Represents an LRU item.
 * @constructor
 * @private
 * @param {String} key
 * @param {Object} value
 */

function ListItem(value) {
  this.value = value;
  this.next = null;
  this.prev = null;
}

// TestCommitmentSpendValidation test the spendability of both outputs within
// the commitment transaction.
//
// The following spending cases are covered by this test:
//   * Alice's spend from the delayed output on her commitment transaciton.
//   * Bob's spend from Alice's delayed output when she broadcasts a revoked
//     commitment transaction.
//   * Bob's spend from his unencumbered output within Alice's commitment
//     transaction.
function commitSpendValidation() {
  var hdSeed = bcoin.ec.random(32);

  // Setup funding transaction output.
  var fundingOutput = new bcoin.coin();
  fundingOutput.hash = constants.ONE_HASH.toString('hex');
  fundingOutput.index = 50;
  fundingOutput.value = 1 * 1e8;

	// We also set up set some resources for the commitment transaction.
	// Each side currently has 1 BTC within the channel, with a total
	// channel capacity of 2BTC.
  var alice = bcoin.ec.generatePrivateKey();
  var alicePub = bcoin.ec.publicKeyCreate(alice, true);
  var bob = bcoin.ec.generatePrivateKey();
  var bobPub = bcoin.ec.publicKeyCreate(bob, true);
  var balance = 1 * 1e8;
  var csvTimeout = 5;
  var revImage = hdSeed;
  var revPub = util.deriveRevPub(bobPub, revImage);

  var commitTX = util.createCommitTX(fundingOutput, alicePub, bobPub, revPub, csvTimeout, balance, balance);
  // var delayOut = commitTX.outputs[0];
  // var regularOut = commitTX.outputs[1];
  var targetOut = util.commitUnencumbered(alicePub);
  var sweep = new bcoin.mtx();
  sweep.addInput(bcoin.coin.fromTX(commitTX, 0));
  var o = new bcoin.output();
  o.script = targetOut;
  o.value = 0.5 * 1e8;
  sweep.addOutput(o);

  // First, we'll test spending with Alice's key after the timeout.
  var delayScript = util.commitSelf(csvTimeout, alicePub, revPub);
  var aliceSpend = util.commitSpendTimeout(delayScript, csvTimeout, alice, sweep);
  sweep.inputs[0].witness = aliceSpend;
  assert(sweep.verify());

	// Next, we'll test bob spending with the derived revocation key to
	// simulate the scenario when alice broadcasts this commitmen
	// transaction after it's been revoked.
  var revPriv = util.deriveRevPriv(bob, revImage);
  var bobSpend = util.commitSpendRevoke(delayScript, revPriv, sweep);
  sweep.inputs[0].witness = bobSpend;
  assert(sweep.verify());

	// Finally, we test bob sweeping his output as normal in the case that
	// alice broadcasts this commitment transaction.
  sweep.inputs.length = 0;
  sweep.addInput(bcoin.coin.fromTX(commitTX, 1));
  var bobScript = util.commitUnencumbered(bobPub);
  var bobRegularSpend = util.commitSpendNoDelay(bobScript, bob, sweep);
  sweep.inputs[0].witness = bobRegularSpend;
  assert(sweep.verify());
}

// TestHTLCSenderSpendValidation tests all possible valid+invalid redemption
// paths in the script used within the sender's commitment transaction for an
// outgoing HTLC.
//
// The following cases are exercised by this test:
// sender script:
//  * reciever spends
//    * revoke w/ sig
//    * HTLC with invalid pre-image size
//    * HTLC with valid pre-image size + sig
//  * sender spends
//    * invalid lock-time for CLTV
//    * invalid sequence for CSV
//    * valid lock-time+sequence, valid sig
function htlcSpenderValidation() {
  var hdSeed = bcoin.ec.random(32);

  var fundingOutput = new bcoin.coin();
  fundingOutput.hash = constants.ONE_HASH.toString('hex');
  fundingOutput.index = 50;
  fundingOutput.value = 1 * 1e8;

  var revImage = hdSeed;
  var revHash = utils.sha256(revImage);
  var payImage = utils.copy(revHash);
  payImage[0] ^= 1;
  var payHash = utils.sha256(payImage);

  var alice = bcoin.ec.generatePrivateKey();
  var alicePub = bcoin.ec.publicKeyCreate(alice, true);
  var bob = bcoin.ec.generatePrivateKey();
  var bobPub = bcoin.ec.publicKeyCreate(bob, true);
  var payValue = 1 * 10e8;
  var cltvTimeout = 8;
  var csvTimeout = 5;

  var htlc = util.createSenderHTLC(
    cltvTimeout, csvTimeout, alicePub,
    bobPub, revHash, payHash);

  var whtlc = util.toWitnessScripthash(htlc);

	// This will be Alice's commitment transaction. In this scenario Alice
	// is sending an HTLC to a node she has a a path to (could be Bob,
	// could be multiple hops down, it doesn't really matter).
  var senderCommit = new bcoin.mtx();
  senderCommit.addInput(fundingOutput);
  senderCommit.addOutput({
    value: payValue,
    script: whtlc
  });

  var prevout = bcoin.coin.fromTX(senderCommit, 0);

  var sweep = new bcoin.mtx();
  sweep.addInput(prevout);
  sweep.addOutput({
    script: bcoin.script.fromRaw('doesnt matter', 'ascii'),
    value: 1 * 10e8
  });

  function testHTLC(witness, result) {
    sweep.inputs[0].witness = witness;
    assert(sweep.verify() === result);
  }

  // revoke w/ sig
  testHTLC(util.senderSpendRevoke(htlc, bob, sweep, revImage), true);
  // htlc with invalid preimage size
  testHTLC(util.senderSpendRedeem(htlc, bob, sweep, new Buffer(45)), false);
  // htlc with valid preimage size & sig
  testHTLC(util.senderSpendRedeem(htlc, bob, sweep, payImage), true);
  // invalid locktime for cltv
  testHTLC(util.senderSpendTimeout(htlc, alice, sweep, cltvTimeout - 2, csvTimeout), false);
  // invalid sequence for csv
  testHTLC(util.senderSpendTimeout(htlc, alice, sweep, cltvTimeout, csvTimeout - 2), false);
  // valid locktime+sequence, valid sig
  testHTLC(util.senderSpendTimeout(htlc, alice, sweep, cltvTimeout, csvTimeout), true);
}

// TestHTLCReceiverSpendValidation tests all possible valid+invalid redemption
// paths in the script used within the reciever's commitment transaction for an
// incoming HTLC.
//
// The following cases are exercised by this test:
//  * reciever spends
//     * HTLC redemption w/ invalid preimage size
//     * HTLC redemption w/ invalid sequence
//     * HTLC redemption w/ valid preimage size
//  * sender spends
//     * revoke w/ sig
//     * refund w/ invalid lock time
//     * refund w/ valid lock time
function htlcReceiverValidation() {
  var hdSeed = bcoin.ec.random(32);

  var fundingOutput = new bcoin.coin();
  fundingOutput.hash = constants.ONE_HASH.toString('hex');
  fundingOutput.index = 50;
  fundingOutput.value = 1 * 1e8;

  var revImage = hdSeed;
  var revHash = utils.sha256(revImage);
  var payImage = utils.copy(revHash);
  payImage[0] ^= 1;
  var payHash = utils.sha256(payImage);

  var alice = bcoin.ec.generatePrivateKey();
  var alicePub = bcoin.ec.publicKeyCreate(alice, true);
  var bob = bcoin.ec.generatePrivateKey();
  var bobPub = bcoin.ec.publicKeyCreate(bob, true);
  var payValue = 1 * 10e8;
  var cltvTimeout = 8;
  var csvTimeout = 5;

  var htlc = util.createReceiverHTLC(
    cltvTimeout, csvTimeout, alicePub,
    bobPub, revHash, payHash);

  var whtlc = util.toWitnessScripthash(htlc);

	// This will be Bob's commitment transaction. In this scenario Alice
	// is sending an HTLC to a node she has a a path to (could be Bob,
	// could be multiple hops down, it doesn't really matter).
  var recCommit = new bcoin.mtx();
  recCommit.addInput(fundingOutput);
  recCommit.addOutput({
    value: payValue,
    script: whtlc
  });
  var prevout = bcoin.coin.fromTX(recCommit, 0);

  var sweep = new bcoin.mtx();
  sweep.addInput(prevout);
  sweep.addOutput({
    script: bcoin.script.fromRaw('doesnt matter', 'ascii'),
    value: 1 * 10e8
  });

  function testHTLC(witness, result) {
    sweep.inputs[0].witness = witness;
    assert(sweep.verify() === result);
  }

  // htlc redemption w/ invalid preimage size
  testHTLC(util.recSpendRedeem(htlc, bob, sweep, new Buffer(45), csvTimeout), false);
  // htlc redemption w/ invalid sequence
  testHTLC(util.recSpendRedeem(htlc, bob, sweep, payImage, csvTimeout - 2), false);
  // htlc redemption w/ valid preimage size
  testHTLC(util.recSpendRedeem(htlc, bob, sweep, payImage, csvTimeout), true);
  // revoke w/ sig
  testHTLC(util.recSpendRevoke(htlc, alice, sweep, revImage), true);
  // refund w/ invalid lock time
  testHTLC(util.recSpendTimeout(htlc, alice, sweep, cltvTimeout - 2), false);
  // refund w/ valid lock time
  testHTLC(util.recSpendTimeout(htlc, alice, sweep, cltvTimeout), true);
}

// funding -> 2of2 multisig
// commitment alice ->
//   output 0: wp2sh(if [alice-revpub] checksig else [alicekey] checksigverify [csvtime] csv endif)
//   output 1: wp2kh([bobkey])
// commitment bob ->
//   output 0: wp2sh(if [bob-revpub] checksig else [bobkey] checksigverify [csvtime] csv endif)
//   output 1: wp2kh([alicekey])

function createChannels() {
  var hdSeed = bcoin.ec.random(32);
  var alice = bcoin.ec.generatePrivateKey();
  var alicePub = bcoin.ec.publicKeyCreate(alice, true);
  var bob = bcoin.ec.generatePrivateKey();
  var bobPub = bcoin.ec.publicKeyCreate(bob, true);
  var channelCapacity = 10 * 1e8;
  var channelBalance = channelCapacity / 2;
  var csvTimeoutAlice = 5;
  var csvTimeoutBob = 4;

  var redeem = util.fundingRedeem(alicePub, bobPub, channelCapacity);

  var fundingOutput = new bcoin.coin();
  fundingOutput.hash = constants.ONE_HASH.toString('hex');
  fundingOutput.index = 0;
  fundingOutput.value = 1 * 1e8;

  var bobElkrem = new ElkremSender(util.deriveElkremRoot(bob, alicePub));
  var bobFirstRevoke = bobElkrem.getIndex(0);
  var bobRevKey = util.deriveRevPub(alicePub, bobFirstRevoke);

  var aliceElkrem = new ElkremSender(util.deriveElkremRoot(alice, bobPub));
  var aliceFirstRevoke = aliceElkrem.getIndex(0);
  var aliceRevKey = util.deriveRevPub(bobPub, aliceFirstRevoke);

  var aliceCommit = util.createCommitTX(
    fundingOutput, alicePub, bobPub, aliceRevKey,
    csvTimeoutAlice, channelBalance, channelBalance);

  var bobCommit = util.createCommitTX(
    fundingOutput, bobPub, alicePub, bobRevKey,
    csvTimeoutAlice, channelBalance, channelBalance);

  fundingOutput.script = redeem.output.script;

  var aliceState = new ChannelState({
    theirLNID: hdSeed,
    id: fundingOutput, // supposed to be an outpoint. do outpoint.fromOptions
    ourCommitKey: alice,
    theirCommitKey: bobPub,
    capacity: channelCapacity,
    ourBalance: channelBalance,
    theirBalance: channelBalance,
    ourCommitTX: aliceCommit,
    fundingInput: fundingOutput,
    ourMultisigKey: alice,
    theirMultisigKey: bobPub,
    fundingScript: redeem.redeem,
    localCSVDelay: csvTimeoutAlice,
    remoteCSVDelay: csvTimeoutBob,
    theirCurrentRevocation: bobRevKey,
    localElkrem: aliceElkrem,
    remoteElkrem: new ElkremReceiver(),
    db: null
  });

  var bobState = new ChannelState({
    theirLNID: hdSeed,
    id: fundingOutput, // supposed to be prevout. do outpoint.fromOptions
    ourCommitKey: bob,
    theirCommitKey: alicePub,
    capacity: channelCapacity,
    ourBalance: channelBalance,
    theirBalance: channelBalance,
    ourCommitTX: bobCommit,
    fundingInput: fundingOutput,
    ourMultisigKey: bob,
    theirMultisigKey: alicePub,
    fundingScript: redeem.redeem,
    localCSVDelay: csvTimeoutBob,
    remoteCSVDelay: csvTimeoutAlice,
    theirCurrentRevocation: aliceRevKey,
    localElkrem: bobElkrem,
    remoteElkrem: new ElkremReceiver(),
    db: null
  });

  var aliceChannel = new Channel({
    state: aliceState
  });

  var bobChannel = new Channel({
    state: bobState
  });

  return { alice: aliceChannel, bob: bobChannel };
}

function simpleAddSettleWorkflow() {
  var channel = createChannels();
  var i, aliceNextRevoke, htlcs, bobNextRevoke;
  var data;

  for (i = 1; i < 4; i++) {
    aliceNextRevoke = channel.alice.extendRevocationWindow();
    htlcs = channel.bob.receiveRevocation(aliceNextRevoke);
    assert(!htlcs || htlcs.length === 0);
    bobNextRevoke = channel.bob.extendRevocationWindow();
    htlcs = channel.alice.receiveRevocation(bobNextRevoke);
    assert(!htlcs || htlcs.length === 0);
  }

  assert(channel.alice.revocationWindowEdge === 3);
  assert(channel.bob.revocationWindowEdge === 3);

  var payPreimage = bcoin.ec.random(32);
  var payHash = utils.sha256(payPreimage);

  var htlc = new HTLCAddRequest();
  htlc.redemptionHashes = [payHash];
  htlc.value = 1e8;
  htlc.expiry = 5;

  channel.alice.addHTLC(htlc);
  channel.bob.receiveHTLC(htlc);

  data = channel.alice.signNextCommitment();
  var aliceSig = data.sig;
  var bobLogIndex = data.index;

  channel.bob.receiveNewCommitment(aliceSig, bobLogIndex);

  data = channel.bob.signNextCommitment();
  var bobSig = data.sig;
  var aliceLogIndex = data.index;

  var bobRev = channel.bob.revokeCurrentCommitment();

  channel.alice.receiveNewCommitment(bobSig, aliceLogIndex);

  htlcs = channel.alice.receiveRevocation(bobRev);
  assert(!htlcs || htlcs.length === 0);

  var aliceRev = channel.alice.revokeCurrentCommitment();

  htlcs = channel.bob.receiveRevocation(aliceRev);
  assert(htlcs && htlcs.length === 1);

  var aliceBalance = 4 * 1e8;
  var bobBalance = 5 * 1e8;

  assert(channel.alice.state.ourBalance === aliceBalance);
  assert(channel.alice.state.theirBalance === bobBalance);
  assert(channel.bob.state.ourBalance === bobBalance);
  assert(channel.bob.state.theirBalance === aliceBalance);
  assert(channel.alice.currentHeight === 1);
  assert(channel.bob.currentHeight === 1);
  assert(channel.alice.revocationWindowEdge === 4);
  assert(channel.bob.revocationWindowEdge === 4);

  // Bob learns of the preimage:
  var preimage = utils.copy(payPreimage);
  var settleIndex = channel.bob.settleHTLC(preimage);

  channel.alice.receiveHTLCSettle(preimage, settleIndex);

  data = channel.bob.signNextCommitment();
  var bobSig2 = data.sig;
  var aliceIndex2 = data.index;

  channel.alice.receiveNewCommitment(bobSig2, aliceIndex2);

  data = channel.alice.signNextCommitment();
  var aliceSig2 = data.sig;
  var bobIndex2 = data.index;
  var aliceRev2 = channel.alice.revokeCurrentCommitment();

  channel.bob.receiveNewCommitment(aliceSig2, bobIndex2);

  var bobRev2 = channel.bob.revokeCurrentCommitment();

  htlcs = channel.bob.receiveRevocation(aliceRev2);
  assert(!htlcs || htlcs.length === 0);

  htlcs = channel.alice.receiveRevocation(bobRev2);
  assert(htlcs && htlcs.length === 1);

  var aliceSettleBalance = 4 * 1e8;
  var bobSettleBalance = 6 * 1e8;
  assert(channel.alice.state.ourBalance === aliceSettleBalance);
  assert(channel.alice.state.theirBalance === bobSettleBalance);
  assert(channel.bob.state.ourBalance === bobSettleBalance);
  assert(channel.bob.state.theirBalance === aliceSettleBalance);
  assert(channel.alice.currentHeight === 2);
  assert(channel.bob.currentHeight === 2);
  assert(channel.alice.revocationWindowEdge === 5);
  assert(channel.bob.revocationWindowEdge === 5);

  assert(channel.alice.ourUpdateLog.size() === 0);
  assert(channel.alice.theirUpdateLog.size() === 0);
  assert(Object.keys(channel.alice.ourLogIndex).length === 0);
  assert(Object.keys(channel.alice.theirLogIndex).length === 0);

  assert(channel.bob.ourUpdateLog.size() === 0);
  assert(channel.bob.theirUpdateLog.size() === 0);
  assert(Object.keys(channel.bob.ourLogIndex).length === 0);
  assert(Object.keys(channel.bob.theirLogIndex).length === 0);
}

function cooperativeChannelClosure() {
  var channel = createChannels();
  var data = channel.alice.initCooperativeClose();
  var sig = data.sig;
  var txid = data.hash;
  var closeTX = channel.bob.completeCooperativeClose(sig);
  assert(utils.equal(txid, closeTX.hash()));

  channel.alice.status = channelStates.OPEN;
  channel.bob.status = channelStates.OPEN;

  var data = channel.bob.initCooperativeClose();
  var sig = data.sig;
  var txid = data.hash;
  var closeTX = channel.alice.completeCooperativeClose(sig);
  assert(utils.equal(txid, closeTX.hash()));
}

commitSpendValidation();
htlcSpenderValidation();
htlcReceiverValidation();
simpleAddSettleWorkflow();
cooperativeChannelClosure();
