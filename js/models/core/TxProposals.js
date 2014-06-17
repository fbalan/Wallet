'use strict';


var imports = require('soop').imports();
var bitcore = require('bitcore');
var util = bitcore.util;
var Transaction = bitcore.Transaction;
var Builder = bitcore.TransactionBuilder;
var Script = bitcore.Script;
var buffertools = bitcore.buffertools;

function TxProposal(opts) {
  this.creator = opts.creator;
  this.createdTs = opts.createdTs;
  this.seenBy = opts.seenBy || {};
  this.signedBy = opts.signedBy || {};
  this.rejectedBy = opts.rejectedBy || {};
  this.builder = opts.builder;
  this.sentTs = opts.sentTs || null;
  this.sentTxid = opts.sentTxid || null;
  this.inputChainPaths = opts.inputChainPaths || [];
  this.comment = opts.comment || null;
}

TxProposal.prototype.toObj = function() {
  var o = JSON.parse(JSON.stringify(this));
  delete o['builder'];
  o.builderObj = this.builder.toObj();
  return o;
};


TxProposal.prototype.setSent = function(sentTxid) {
  this.sentTxid = sentTxid;
  this.sentTs = Date.now();
};

TxProposal.fromObj = function(o) {
  var t = new TxProposal(o);
  var b = new Builder.fromObj(o.builderObj);
  t.builder = b;
  return t;
};

TxProposal.getSentTs = function() {
  return this.sentTs;
};

TxProposal.prototype.mergeBuilder = function(other) {

  var v0 = this.builder;
  var v1 = other.builder;

  // TODO: enhance this
  var before = JSON.stringify(v0.toObj());
  v0.merge(v1);
  var after = JSON.stringify(v0.toObj());
  if (after !== before) hasChanged++;
};

TxProposal.prototype.mergeMetadata = function(v1) {

  var events = [];
  var v0 = this;
  Object.keys(v1.seenBy).forEach(function(k) {
    if (!v0.seenBy[k]) {
      v0.seenBy[k] = v1.seenBy[k];
      events.push({
        type: 'seen',
        cId: k,
        txId: hash
      });
    }
  });

  Object.keys(v1.signedBy).forEach(function(k) {
    if (!v0.signedBy[k]) {
      v0.signedBy[k] = v1.signedBy[k];
      events.push({
        type: 'signed',
        cId: k,
        txId: hash
      });
    }
  });

  Object.keys(v1.rejectedBy).forEach(function(k) {
    if (!v0.rejectedBy[k]) {
      v0.rejectedBy[k] = v1.rejectedBy[k];
      events.push({
        type: 'rejected',
        cId: k,
        txId: hash
      });
    }
  });

  if (!v0.sentTxid && v1.sentTxid) {
    v0.sentTs = v1.sentTs;
    v0.sentTxid = v1.sentTxid;
    events.push({
      type: 'broadcast',
      txId: hash
    });
  }

  return events;

};

module.exports = require('soop')(TxProposal);


function TxProposals(opts) {
  opts = opts || {};
  this.walletId = opts.walletId;
  this.network = opts.networkName === 'livenet' ?
    bitcore.networks.livenet : bitcore.networks.testnet;
  this.txps = {};
}

TxProposals.fromObj = function(o) {
  var ret = new TxProposals({
    networkName: o.networkName,
    walletId: o.walletId,
  });
  o.txps.forEach(function(o2) {
    var t = TxProposal.fromObj(o2);
    var id = t.builder.build().getNormalizedHash().toString('hex');
    ret.txps[id] = t;
  });
  return ret;
};

TxProposals.prototype.getNtxids = function() {
  return Object.keys(this.txps);
};

TxProposals.prototype.toObj = function(onlyThisNtxid) {
  var ret = [];
  for (var id in this.txps) {

    if (onlyThisNtxid && id != onlyThisNtxid)
      continue;

    var t = this.txps[id];
    if (!t.sent)
      ret.push(t.toObj());
  }
  return {
    txps: ret,
    walletId: this.walletId,
    networkName: this.network.name,
  };
};

TxProposals.prototype._startMerge = function(myTxps, theirTxps) {
  var fromUs = 0,
    fromTheirs = 0,
    merged = 0;
  var toMerge = {},
    ready = {},
    events = [];

  for (var hash in theirTxps) {
    if (!myTxps[hash]) {
      ready[hash] = theirTxps[hash]; // only in theirs;
      events.push({
        type: 'new',
        cid: theirTxps[hash].creator,
        tx: hash
      });
      fromTheirs++;
    } else {
      toMerge[hash] = theirTxps[hash]; // need Merging
      merged++;
    }
  }

  for (var hash in myTxps) {
    if (!toMerge[hash]) {
      ready[hash] = myTxps[hash]; // only in myTxps;
      fromUs++;
    }
  }

  return {
    stats: {
      fromUs: fromUs,
      fromTheirs: fromTheirs,
      merged: merged,
    },
    ready: ready,
    toMerge: toMerge,
    events: events
  };
};

// TODO add signatures.
TxProposals.prototype._mergeMetadata = function(myTxps, theirTxps, mergeInfo) {
  var toMerge = mergeInfo.toMerge;
  var events = [];

  Object.keys(toMerge).forEach(function(hash) {
    var v0 = myTxps[hash];
    var v1 = toMerge[hash];
    var newEvents = v0.mergeMetadata(v1);
    events.concat(newEvents);
  });

  return {
    events: events.concat(mergeInfo.events),
    hasChanged: events.length
  };
};


TxProposals.prototype._mergeBuilder = function(myTxps, theirTxps, mergeInfo) {
  var toMerge = mergeInfo.toMerge;

  for (var hash in toMerge) {
    var v0 = myTxps[hash];
    var v1 = myTxps[hash];

    v0.mergeBuilder(v1);
  }

};

TxProposals.prototype.merge = function(t) {
  if (this.network.name !== t.network.name)
    throw new Error('network mismatch in:', t);

  var myTxps = this.txps;
  var theirTxps = t.txps;

  var mergeInfo = this._startMerge(myTxps, theirTxps);
  var result = this._mergeMetadata(myTxps, theirTxps, mergeInfo);
  result.hasChanged += this._mergeBuilder(myTxps, theirTxps, mergeInfo);

  Object.keys(mergeInfo.toMerge).forEach(function(hash) {
    mergeInfo.ready[hash] = myTxps[hash];
  });

  mergeInfo.stats.hasChanged = result.hasChanged;
  mergeInfo.stats.events = result.events;

  this.txps = mergeInfo.ready;
  return mergeInfo.stats;
};

TxProposals.prototype.add = function(data) {
  var ntxid = data.builder.build().getNormalizedHash().toString('hex');
  this.txps[ntxid] = new TxProposal(data);
  return ntxid;
};


TxProposals.prototype.setSent = function(ntxid, txid) {
  //sent TxProposals are local an not broadcasted.
  this.txps[ntxid].setSent(txid);
};


TxProposals.prototype.getTxProposal = function(ntxid, copayers) {
  var txp = this.txps[ntxid];
  var i = JSON.parse(JSON.stringify(txp));
  i.builder = txp.builder;
  i.ntxid = ntxid;
  i.peerActions = {};

  if (copayers) {
    for (var j = 0; j < copayers.length; j++) {
      var p = copayers[j];
      i.peerActions[p] = {};
    }
  }

  for (var p in txp.seenBy) {
    i.peerActions[p] = {
      seen: txp.seenBy[p]
    };
  }
  for (var p in txp.signedBy) {
    i.peerActions[p] = i.peerActions[p] || {};
    i.peerActions[p].sign = txp.signedBy[p];
  }
  var r = 0;
  for (var p in txp.rejectedBy) {
    i.peerActions[p] = i.peerActions[p] || {};
    i.peerActions[p].rejected = txp.rejectedBy[p];
    r++;
  }
  i.rejectCount = r;

  var c = txp.creator;
  i.peerActions[c] = i.peerActions[c] || {};
  i.peerActions[c].create = txp.createdTs;
  return i;
};

//returns the unspent txid-vout used in PENDING Txs
TxProposals.prototype.getUsedUnspent = function(maxRejectCount) {
  var ret = {};
  for (var i in this.txps) {
    var u = this.txps[i].builder.getSelectedUnspent();
    var p = this.getTxProposal(i);
    if (p.rejectCount > maxRejectCount || p.sentTxid)
      continue;

    for (var j in u) {
      ret[u[j].txid + ',' + u[j].vout] = 1;
    }
  }
  return ret;
};


module.exports = require('soop')(TxProposals);
