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

describe('Script', function() {
  // TestCommitmentSpendValidation test the spendability of both outputs within
  // the commitment transaction.
  //
  // The following spending cases are covered by this test:
  //   * Alice's spend from the delayed output on her commitment transaciton.
  //   * Bob's spend from Alice's delayed output when she broadcasts a revoked
  //     commitment transaction.
  //   * Bob's spend from his unencumbered output within Alice's commitment
  //     transaction.
  it('should test commitment spend validation', function() {
    var hdSeed = crypto.randomBytes(32);

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
  });

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
  it('should test HTLC sender spend validation', function() {
    var hdSeed = crypto.randomBytes(32);

    var fundingOutput = new bcoin.coin();
    fundingOutput.hash = constants.ONE_HASH.toString('hex');
    fundingOutput.index = 50;
    fundingOutput.value = 1 * 1e8;

    var revImage = hdSeed;
    var revHash = crypto.sha256(revImage);
    var payImage = utils.copy(revHash);
    payImage[0] ^= 1;
    var payHash = crypto.sha256(payImage);

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
  });

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
  it('should test HTLC receiver spend validation', function() {
    var hdSeed = crypto.randomBytes(32);

    var fundingOutput = new bcoin.coin();
    fundingOutput.hash = constants.ONE_HASH.toString('hex');
    fundingOutput.index = 50;
    fundingOutput.value = 1 * 1e8;

    var revImage = hdSeed;
    var revHash = crypto.sha256(revImage);
    var payImage = utils.copy(revHash);
    payImage[0] ^= 1;
    var payHash = crypto.sha256(payImage);

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
  });
});
