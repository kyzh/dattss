// Copyright Stanislas Polu
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var util = require('util');
var fwk = require('fwk');
var http = require('http');


exports.CONFIG = fwk.populateConfig(require("../config.js").config);
 

/**
 * DaTtSs Client Library
 *
 * The Client Library requires the user, the auth key and if required the server 
 * and port.
 * These information be passed directly at construction or by configuration either
 * on the command line (--XX=yyy) or using environment variables:
 *   DATTSS_CLIENT_USER: the username
 *   DATTSS_CLIENT_AUTH: the auth key
 *   DATTSS_SERVER_HOST: the DaTtSs server host to use
 *   DATTSS_SERVER_PORT: the DaTtSs server port to use
 *   DATTSS_PERCENTILE : the percentile value (0.1 default)
 *
 * @extends {}
 *
 * @param spec { user, [auth], [host], [port], [pct] }
 */
var dattss = function(spec, my) {
  my = my || {};
  var _super = {};

  my.user = spec.user || exports.CONFIG['DATTSS_CLIENT_USER'];
  my.auth = spec.auth || exports.CONFIG['DATTSS_CLIENT_AUTH'];
  my.host = spec.host || exports.CONFIG['DATTSS_SERVER_HOST'];
  my.port = spec.port || parseInt(exports.CONFIG['DATTSS_SERVER_PORT'], 10);
  my.pct  = spec.pct  || parseFloat(exports.CONFIG['DATTSS_PERCENTILE']);

  my.name = spec.name || 'noname';
  my.start = Date.now();

  // accumulators
  my.acc = { 'c': {},
             'ms': {},
             'g': {} };

  // public
  var agg;              /* agg(stat, value); */
  //var error;            /* error(err, ctx); */
  //var warning;          /* warning(err, ctx); */

  // private
  var do_commit;        /* do_commit(); */
  var make_partials;    /* make_partials(); */
  
  var that = {};


  /***********************************************************************
   * PRIVATE COMPUTATION AND COMMIT FUNCTIONALITIES                      *
   ***********************************************************************/
  
  /**
   * `make_partials` computes the partial aggregate and cleans-up the various
   * accumulators
   * @return the dictionary of paritals computed from the accumulators
   */
  make_partials = function() {
    var partials = { 'c': [],
                     'ms': [],
                     'g': [] };

    ['c', 'ms', 'g'].forEach(function(typ) {
      for(var st in my.acc[typ]) {
        if(my.acc[typ].hasOwnProperty(st) && my.acc[typ][st].length > 0) {
          // prepare the partial
          var p = { typ: typ,
                    nam: st,
                    sum: 0,
                    cnt: 0 };

          // first aggregation pass (my.acc[typ][st] orderd by date)
          my.acc[typ][st].sort(function(a,b) { return a.date-b.date; });
          my.acc[typ][st].forEach(function(v) {
            p.sum += v.value;
            p.cnt += 1;
            p.max = ((p.max || v.value) > v.value) ? p.max : v.value;
            p.min = ((p.min || v.value) < v.value) ? p.min : v.value;
            p.lst = v.value;
            p.fst = p.fst || v.value;
          });

          // top 10 and bot 10 computation (my.acc[typ][st] ordered by value)
          my.acc[typ][st].sort(function(a,b) { return a.value-b.value; });
          var len = my.acc[typ][st].length;
          var bidx = Math.max(Math.min(Math.ceil(my.pct * len), len-1), 0);
          var tidx = Math.max(Math.min(Math.round((1.0 - my.pct) * len), len-1), 0);
          p.bot = my.acc[typ][st][bidx].value;
          p.top = my.acc[typ][st][tidx].value;

          // store
          partials[typ].push(p);
        }
      }
    });

    // cleanup accumulators
    my.acc = { 'c': {},
               'ms': {},
               'g': {} };
 
    return partials;
  };

  /**
   * `do_commit` computes the current partial-aggregates and send them to the
   * server for reporting and aggregation. `do_commit` is called periodically 
   * every DATTSS_PUSH_PERIOD (5s by default)
   */
  do_commit = function() {
    var commit = { nam: my.name,
                   upt: process.uptime(),
                   mem: process.memoryUsage().rss,
                   prt: make_partials() };
    console.log('========================================');
    console.log(util.inspect(commit, false, 10));
    console.log('=++++++++++++++++++++++++++++++++++++++=');
  };


  /***********************************************************************
   * COMMIT TIMER INITIALIZATION                                         *
   ***********************************************************************/
  my.itv = setInterval(do_commit, exports.CONFIG['DATTSS_PUSH_PERIOD']);


  /***********************************************************************
   * PUBLIC STATISTICS CAPTURE INTERFACE                                 *
   ***********************************************************************/
  
  /**
   * `agg` is in charge of aggregating a new value for a given statistic for
   * the current process.
   * @param stat the name of the statistic to aggregate
   * @param value a DaTtSs-like value '1c' | '253ms' | '34g'
   */
  agg = function(stat, value) {
    var stat_m = /^([A-Za-z0-9\-\_\.\:]+)$/.exec(stat);
    if(!stat_m)
      return; // fail silently

    var val_m = /^(-?[0-9]+)(c|ms|g)/.exec(value);
    if(val_m) {
      var typ = val_m[2];
      var val = parseInt(val_m[1], 10);

      my.acc[typ][stat] = my.acc[typ][stat] || [];
      my.acc[typ][stat].push({ date: Date.now(), value: val });
    }
  };


  fwk.method(that, 'agg', agg, _super);

  return that;
};

exports.dattss = dattss;


/**
 * The process function is a factory for process singletons (by user and name)
 * If the dattss object does not exist for the specified process (user + name)
 * then it creates a new one. It returns the existing one otherwise without 
 * modifiying the configuration (auth, host, port)
 *
 * @param spec { name, [user], [host], [port], [pct] } or just name as a string
 * @return a dattss process object
 */

exports.CACHE = {};

exports.process = function(spec) {
  if(typeof spec === 'string') {
    spec = { name: spec };
  }

  var cache = exports.CACHE;

  spec.user = spec.user || exports.CONFIG['DATTSS_CLIENT_USER'];
  spec.auth = spec.auth || exports.CONFIG['DATTSS_CLIENT_AUTH'];
  spec.host = spec.host || exports.CONFIG['DATTSS_SERVER_HOST'];
  spec.port = spec.port || parseInt(exports.CONFIG['DATTSS_SERVER_PORT'], 10);
  spec.pct  = spec.pct  || parseFloat(exports.CONFIG['DATTSS_PERCENTILE']);
  spec.name = spec.name || 'noname';

  cache[spec.user] = cache[spec.user] || {};
  
  if(typeof cache[spec.user][spec.name] === 'undefined') {
    cache[spec.user][spec.name] = dattss(spec);
  };

  return cache[spec.user][spec.name];
};
