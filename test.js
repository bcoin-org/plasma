var bcoin = require('../bcoin');
var bn = require('bn.js');
var constants = bcoin.constants;
var utils = require('../bcoin/lib/utils/utils');
var assert = utils.assert;
var BufferWriter = require('../bcoin/lib/utils/writer');
var BufferReader = require('../bcoin/lib/utils/reader');
var opcodes = constants.opcodes;
var hashType = constants.hashType;
var elkrem = require('./elkrem');
var ElkremSender = elkrem.ElkremSender;
var ElkremReceiver = elkrem.ElkremReceiver;
var util = require('./scriptutil');
var ChannelState = require('./channelstate');
var Channel = require('./channel');
var wire = require('./wire');
var CommitRevocation = wire.CommitRevocation;
var HTLCAddRequest = wire.HTLCAddRequest;
var List = require('./list');


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

  channel.alice.status = Channel.states.OPEN;
  channel.bob.status = Channel.states.OPEN;

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
