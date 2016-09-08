'use strict';

var bcoin = require('bcoin');
var constants = bcoin.constants;
var utils = require('bcoin/lib/utils/utils');
var crypto = bcoin.crypto;
var assert = utils.assert;
var BufferWriter = require('bcoin/lib/utils/writer');
var BufferReader = require('bcoin/lib/utils/reader');
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

bcoin.cache();

// Steps:
// funding:
// alice (5btc) & bob (5btc) funds -> wp2sh(2of2 multisig) (10btc)
//
// commitment (redeems from funding tx):
// both sides have their own versions of the commit tx.
// alice ->
//   input 0: funding
//   output 0 (5btc):
//     wp2sh(if [revpub] checksig else [alicekey] checksigverify [csvtime] csv endif)
//   output 1 (5btc):
//     wp2kh([bobkey])
// bob ->
//   input 0: funding
//   output 0 (5btc):
//     wp2sh(if [revpub] checksig else [bobkey] checksigverify [csvtime] csv endif)
//   output 1 (5btc):
//     wp2kh([alicekey])
//
// updating state and revoking old commits:
// alice can create a new htlc (1btc) and send it to bob:
// this htlc gets tacked on as an output of the new commit tx.
// alice ->
//   input 0: funding
//   output 0 (4btc):
//     wp2sh(if [revpub] checksig else [alicekey] checksigverify [csvtime] csv endif)
//   output 1 (5btc):
//     wp2kh([bobkey])
//   output 2 (1btc): sender htlc
//     if if [revhash] else size [32] equalverify [payhash] endif swap
//     sha256 equalverify [bobkey] checksig else [cltvtime] cltv [csvtime]
//     csv 2drop [alicekey] checksig endif
// alice signs the next commitment and sends the sig to bob.
// bob also signs the next commitment and revokes the current commitment.
// bob sends his sig and the revocation to alice.
// alice revokes the current commitment and sends the revocation to bob.
// at this point, the state is updated and the htlc is added to the _new_ commitment tx.
// bob ->
//   input 0: funding
//   output 0 (5btc):
//     wp2sh(if [revpub] checksig else [bobkey] checksigverify [csvtime] csv endif)
//   output 1 (4btc):
//     wp2kh([alicekey])
//   output 2 (1btc): receiver htlc
//     if size [32] equalverify sha256 [payhash] equalverify [csvtime] csv
//     drop [bobkey] checksig else if sha256 [revhash] equalverify else [cltvtime]
//     checklocktimeverify drop endif [alicekey] checksig endif
//
// revocation preimages:
// the actual revocation preimages are the tweak values for key derivation.
// the revocation preimages themselves are derived from the elkrem tree.
// this means that alice can derive bob's necessary public revocation key,
// but he does not know the private key yet without the revocation preimage.
// when alice creates a script with bob's rev key, she does:
// rev=elkrem[currentheight], revkey=derive(bobCommitPub, rev)
// when she revokes a commit, she sends bob the revocation preimage.
// bob can then do:
// revpriv=derive(bobCommitPriv, rev)
// and have his private key, thereby revoking the old commit
//
// if the commit state is updated, and bob's original commit tx is
// broadcast, alice can redeem bob's output without a timeout,
// effectively punishing him by taking all his money.
//
// closure:
// alice can initiate a cooperative closure.
// she signs the final tx of:
//   input 0: funding
//   output 0 (4btc): [alice-address]
//   output 1 (6btc): [bob-address]
// she sends the sig and txid to bob.
// bob recreates the closure tx on his
// side, verifies the sig and txid.
// bob adds his sig and broadcasts the closure tx.

function alloc(num) {
  var buf = new Buffer(32);
  buf.fill(num);
  return buf;
}

function createChannels() {
  var hdSeed = alloc(1);
  var alice = alloc(2);
  var alicePub = bcoin.ec.publicKeyCreate(alice, true);
  var bob = alloc(3);
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
  fundingOutput.script = redeem.output.script;

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

  var aliceState = new ChannelState({
    theirLNID: hdSeed,
    id: fundingOutput,
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

    var payPreimage = alloc(4);
    var payHash = crypto.sha256(payPreimage);

    // Bob requests a payment from alice.
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

    // utils.log(channel.alice.localCommitChain.tip());
    // utils.log(channel.bob.localCommitChain.tip());

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
