var fwk = require('fwk');
var events = require('events');
var fs = require('fs');
var util = require('util');
var assert = require('assert');
var mkdirp = require('mkdirp');

/**
 * Process Object 
 *
 * in charge of receiving, storing, updating counters received
 * for a given process
 *
 * The process objects receives partial aggregates from a process. 
 * These partial aggregates should be 5s-partial aggregates but this is
 * not an hypothesis. Engine marks the receival time of these 
 * partial aggregates and transfer them to the process object. If the
 * is not known by engine yet, initialization takes place and the
 * current value is read from the disk. If the uptime value of the
 * partial aggregate received is below the local uptime value, that
 * means that a restart happened and the partials/stats are cleared.
 *
 * Finally every minute the commit method of the process is called:
 * the process then calculate a 1mn partial aggregate to be stored on
 * disk.
 *
 * @inherits events.EventEmitter
 *
 * @param {cfg, user, name, dts}
 */
var process = function(spec, my) {
  my = my || {};
  var _super = {};

  my.cfg = spec.cfg;
  my.user = spec.user;
  my.name = spec.name;
  my.dts = spec.dts;

  my.last = Date.now();
  my.dirty = false;

  my.user_dir = my.cfg['DATTSS_STORAGE_PATH'] + '/' + my.user;
  my.curr_dir = my.user_dir + '/current';

  // current
  my.cur = { nam: my.name,
             upt: 0,
             sts: { 'c': [],
                    'g': [],
                    'ms': [] } };
  // partials
  my.prts = { 'c': {},
              'g': {},
              'ms': {} };

  // public
  var init;              /* init(cb); */
  var destroy;           /* detroy(); */
  var agg;               /* agg(data); */
  var commit;            /* commit(); */
  var current;           /* current(); */
  var count;             /* count(); */
  var stat;              /* stat(type, name, cb); */

  // private
  var slide_partials;    /* slide_partials() */


  var that = new events.EventEmitter();


  /*********************************************
   * PRIVATE HELPER FUNCTIONS                  *
   *********************************************/

  /**
   * Slide the partials to only keep the ones that are within the 
   * my.cfg['DATTSS_USER_CROND_PERIOD'] window. This function is 
   * indempotent and can be called as much as needed
   * @param force_dirty if set to true all clean partials are removed
   *                    this is used before commit to avoid writing
   *                    a value to disk twice
   */
  slide_partials = function(force_dirty) {
    var now = Date.now();
    ['c', 'g', 'ms'].forEach(function(typ) {
      // update partials sliding window
      var empty = [];
      for(var st in my.prts[typ]) {
        // we keep around dirty partials plus the ones that are less
        // than a DATTSS_USER_CROND_PERIOD (to have moving averages)
        while(my.prts[typ][st].length > 0 && 
              !my.prts[typ][st][0].drt &&
              (force_dirty || (now - my.prts[typ][st][0].rcv) >= my.cfg['DATTSS_USER_CROND_PERIOD'])) {
          my.prts[typ][st].splice(0,1);
          //console.log('REMOVED ' + typ + ' ' + st);
        }
        //console.log(my.name + ' ' + typ + ':' + st + ' ' + my.prts[typ][st].length);
      }
    });
  };



  /*********************************************
   * PUBLIC FUNCTIONS                          *
   *********************************************/

  /**
   * retrieves the /{my.user}/current/{my.name} file to reconstruct
   * the my.current object (see engine.js for data structure)
   * It's in the current object that stats differ the most by type.
   * All stats type specific current values can be calculated from
   * the last minute 5s-partial aggregates: 'c' avg, 'g' dlt as well
   * as 'ms' max.
   * @param cb(err) error if something went wrong
   */
  init = function(cb) {
    fs.readFile(my.curr_dir + '/' + my.name + '.cur', 
                'utf8', function(err, data) {
                  if(err) {
                    if(err.code !== 'ENOENT') {
                      cb(err);
                    }
                    else {
                      // process does not exist yet
                      cb();
                    }
                  }
                  else {
                    try {
                      my.cur = JSON.parse(data);
                      //console.log('INIT: ' + my.user + ' ' + my.name);
                      //console.log(util.inspect(my.cur, false, 10));
                    }
                    catch(err) {
                      console.log('ERROR: [process] `init`: ' +
                                  'Init parse failed for ' + my.user + ':' + my.name);
                      console.log('DATA: ' + data);
                      console.log(err);
                    }
                    cb();
                  }
                });
  };

  /**
   * Destroys the current file for this process so that it won't appear
   * anymore for that user's current view
   */
  destroy = function() {
    console.log('DESTROY: ' + my.name);
    fs.unlink(my.curr_dir + '/' + my.name + '.cur', function(err) {
      if(err && err.code !== 'ENOENT') {
        console.log('ERROR: [process] `destroy`: ' +
                    'Unlink failed for ' + my.user + ':' + my.name);
        console.log(err);
      }
      /* DaTtSs */ my.dts.srv.agg('proc.destroy', '1c');
      console.log('UNLINK: ' + my.curr_dir + '/' + my.name + '.cur');
    });
  };


  /**
   * This functions is in charge of aggregating a 5s-partial aggregate.
   * 5s is not a compulsory value here as we're storing all arrival times
   * and aggregating the whole list of partial aggregate on demand,
   * nevertheless, the systems expects 5s-partial aggregates.
   * @param data the partial aggregate (see engine.js for structure)
   */
  agg = function(data) {
    my.dirty = true;
    my.last = Date.now();

    // handle restart
    if((my.cur.upt || 0) > data.upt) {
      my.cur = { nam: my.name,
                 upt: 0,
                 sts: { 'c': [],
                        'g': [],
                        'ms': [] } };
      my.prts = { 'c': {},
                  'g': {},
                  'ms': {} };
    }

    // update current process info
    my.cur.upt = data.upt;
    my.cur.lst = my.last;

    slide_partials();

    ['c', 'g', 'ms'].forEach(function(typ) {
      // data.prt -> my.prts
      data.prt[typ].forEach(function(prt) {
        my.prts[typ][prt.nam] = my.prts[typ][prt.nam] || [];
        prt.rcv = my.last;
        prt.drt = true;
        my.prts[typ][prt.nam].push(prt);
      });

      for(var st in my.prts[typ]) {
        // partial just received (lprt for 'c' calculation)
        var lprt = {};
        data.prt[typ].forEach(function(prt) {
          if(prt.nam === st)
            lprt = prt;
        });

        // find and remove st in sts[typ] (lsts for 'c' calculation)
        var lsts = {};
        for(var i = my.cur.sts[typ].length - 1; i >= 0; i--) {
          if(my.cur.sts[typ][i].nam === st) {
            lsts = my.cur.sts[typ][i];
            my.cur.sts[typ].splice(i, 1);
          }
        }

        var work = { typ: typ, sum: 0, cnt: 0, 
                     max: null, min: null, 
                     lst: null, fst: null,
                     emp: null };
        //console.log(typ + '_' + st + ': ' + my.prts[typ][st].length);
        my.prts[typ][st].forEach(function(p) {
          work.sum += p.sum;
          work.cnt += p.cnt;
          work.max = ((work.max || p.max) > p.max) ? work.max : p.max;
          work.min = ((work.min || p.min) < p.min) ? work.min : p.min;
          work.lst = p.lst;
          work.fst = (work.fst === null) ? p.fst : work.fst;
          work.emp = work.emp || p.emp;
        });

        switch(work.typ) {
          case 'c':
            // this time can be a little off (see slide_partials)
            var sec = my.cfg['DATTSS_USER_CROND_PERIOD'] / 1000;
            my.cur.sts[typ].push({ typ: 'c',
                                   nam: st,
                                   emp: (work.emp === null) ? (lsts.emp || false) : work.emp,
                                   sum: (lsts.sum || 0) + (lprt.sum || 0),
                                   avg: (work.sum / sec).toFixed(2) });
            break;
          case 'g':
            my.cur.sts[typ].push({ typ: 'g',
                                   nam: st,
                                   emp: (work.emp === null) ? (lsts.emp || false) : work.emp,
                                   lst: (work.lst !== null) ? work.lst 
                                            : (lsts.lst || null),
                                   avg: (work.cnt !== 0) ? (work.sum / work.cnt).toFixed(2) 
                                            : null,
                                   max: work.max,
                                   min: work.min });
            break;
          case 'ms':
            my.cur.sts[typ].push({ typ: 'ms',
                                   nam: st,
                                   emp: (work.emp === null) ? (lsts.emp || false) : work.emp,
                                   avg: (work.cnt !== 0) ? (work.sum / work.cnt).toFixed(2) 
                                            : null,
                                   max: work.max,
                                   min: work.min });
            break;
          }
        }
    });

    that.emit('update');
  };


  /**
   * ready to be committed. Otherwise it does not write anything
   */
  commit = function() {
    if(!my.dirty)
      return;

    var now = Date.now();
    var iso = require('./isoperiod.js').isoperiod({ date: now });
    var proc_dir = my.user_dir + '/' + iso.week() + '_' + iso.day() + '/' + my.name;

    var mplex = fwk.mplex({});
    // if it fails, writing will fail later on
    mkdirp(proc_dir, mplex.callback());
    mkdirp(my.curr_dir, mplex.callback());

    mplex.go(function() {
      // write back current
      fs.writeFile(my.curr_dir + '/' + my.name + '.cur', JSON.stringify(my.cur), 'utf8', function(err) {
        if(err) {
          console.log('ERROR: [process] `commit`: ' + 
                      'Current writeFile failed for ' + my.user + ':' + my.name);
          console.log(err);
        }
      });

      slide_partials(true);

      ['c', 'g', 'ms'].forEach(function(typ) {
        // compute 1mn-partial-aggregates and append to file on disk 
        for(var st in my.prts[typ]) {
          // avoids aggregating empty values
          if(my.prts[typ][st].length === 0)
            continue;
          // remove dirtiness
          my.prts[typ][st].forEach(function(p) {
            assert.ok(p.drt);
            p.drt = false;
          });

          var agg = require('./partials.js').agg_partials(my.prts[typ][st]);
          var path = proc_dir + '/' + typ + '_' + st + '.prt';  

          var ws = fs.createWriteStream(path, { flags: 'a', encoding: 'utf8', mode: 0666 });
          ws.on('error', function(err) {
            console.log('ERROR: [process] `commit`: ' + 
                        'WriteStream failed for ' + path);
            console.log(err);
          });
        
          ws.write(iso.hour() + ',' + iso.minute() + ',' +
                   require('./partials.js').stringify(agg) + '\n');
          ws.end();
          ws.destroySoon();
          that.emit(typ + ':' + st + ':commit', iso, agg);
        }
      });

    });

    /* DaTtSs */ my.dts.srv.agg('proc.commit', '1c');
  };

  /**
   * returns the current value by computing a relative last instead
   * of an absolute one
   */
  current = function() {
    var cur = fwk.shallow(my.cur);
    cur.lst = Date.now() - cur.lst;
    ['c', 'g', 'ms'].forEach(function(typ) {
      cur.sts[typ].sort(function(a,b) { 
        if(a.nam < b.nam) return -1;
        if(a.nam > b.nam) return 1;
        return 0;
      });
    });
    return cur;
  };
  
  /**
   * Returns the number of stats active in the process
   */
  count = function() {
    var count = 0;
    ['c', 'g', 'ms'].forEach(function(typ) {
      count += my.cur.sts[typ].length;
    });
    return count;
  };

  /**
   * Returns a stat object (wired for update with the current process)
   * The returned cache object is fully loaded
   * @param type the stat type
   * @param name the stat name
   * @param cb(err, st) the callback
   */
  var stat = function(type, name, cb) {
    var now = Date.now();
    var stat = require('./stat.js').stat({ cfg: my.cfg,
                                           user: my.user,
                                           process: my.name,
                                           type: type,
                                           name: name,
                                           dts: my.dts });
    stat.load(function(err) {
      if(err) {
        cb(err);
      }
      else {
        /* DaTtSs */ my.dts.srv.agg('proc.stat', '1c');
        cb(null, stat);
      }
    });
  };
  

  fwk.getter(that, 'last', my, 'last');
  fwk.getter(that, 'name', my, 'name');
  fwk.getter(that, 'dirty', my, 'dirty');

  fwk.method(that, 'agg', agg, _super);
  fwk.method(that, 'init', init, _super);
  fwk.method(that, 'destroy', destroy, _super);
  fwk.method(that, 'commit', commit, _super);
  fwk.method(that, 'current', current, _super);
  fwk.method(that, 'count', count, _super);
  fwk.method(that, 'stat', stat, _super);
  
  return that;
};

exports.process = process;

