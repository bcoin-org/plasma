var bcoin = require('../bcoin');
var constants = bcoin.constants;

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

exports.CommitRevocation = CommitRevocation;
exports.HTLCAddRequest = HTLCAddRequest;
