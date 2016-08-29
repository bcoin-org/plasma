'use strict';

var bcoin = require('../../bcoin');
var constants = bcoin.constants;
var utils = require('../../bcoin/lib/utils/utils');
var assert = utils.assert;
var BufferWriter = require('../../bcoin/lib/utils/writer');
var BufferReader = require('../../bcoin/lib/utils/reader');
var opcodes = constants.opcodes;
var hashType = constants.hashType;
var elkrem = require('../elkrem');
var ElkremSender = elkrem.ElkremSender;
var ElkremReceiver = elkrem.ElkremReceiver;
var util = require('../scriptutil');
var ChannelState = require('../channelstate');
var Channel = require('../channel');
var wire = require('../wire');
var CommitRevocation = wire.CommitRevocation;
var HTLCAddRequest = wire.HTLCAddRequest;
var List = require('../list');

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

describe('Channel', function() {
  it('should test simple add and settle workflow', function() {
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
  });

  it('should test cooperative closure', function() {
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
  });
});
