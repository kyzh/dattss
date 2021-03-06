var fwk = require('fwk');
var events = require('events');
var util = require('util');
var fs = require('fs');

/**
 * Engine Object 
 *
 * in charge of receiving, storing, updating stats (counter, gauge, timers)
 * received from users/apps.
 *
 * Engine offers a fairly simple interface:
 * - `agg` is the aggregation interface which receives partial aggregates
 *   from the apps, stores it in memory in the `app` object and make sure
 *   to write it to disk every minutes (minute partial aggregates as well
 *   as current status)
 * - on(user) for realtime reporting of updates
 * - current(user) to retrive current state for a user
 *
 * @inherits events.EventEmitter
 *
 * @param {cfg, dts}
 */
var engine = function(spec, my) {
  my = my || {};
  var _super = {};

  my.cfg = spec.cfg; 
  my.dts = spec.dts;

  my.users = {};

  my.stat_cache = fwk.cache({ size: my.cfg['DATTSS_STAT_CACHE_SIZE'],
                              interval: my.cfg['DATTSS_STAT_CACHE_INTERVAL'],
                              evict: 'LRU' });

  // public
  var agg;                    /* agg(user, name, data); */
  
  var current;                /* current(user, cb); */
  var stat;                   /* stat(user, process, type, name, cb); */
  var destroy;                /* destroy(user, process, cb); */
  
  // private
  var user_get;               /* user_get(user, cb); */
  var user_crond;             /* user_crond() */
  var user_evict;             /* user_evict(user) */
  var process_init;           /* process_init(user, process, cb); */


  var that = new events.EventEmitter();


  /*********************************************
   *  USER MANAGEMENT PRIVATE FUNCTIONS        *
   *********************************************/

  /**
   * Handles the asycnrhonous loading of a process. If the process does
   * not exist, then it is created.
   * @param user the user name or email
   * @param name the process name
   * @param cb(err, process) the result callback
   */
  process_init = function(user, name, cb) {
    var p = require('./process').process({ cfg: my.cfg, 
                                           user: user,
                                           name: name,
                                           dts: my.dts });
    p.init(function(err) {
      if(err) {
        cb(err);
      }
      else {
        // update mechanism
        p.on('update', function() {
          that.emit(user + ':update', name, p.current());
        });
        cb(null, p);
      }
    });
  };


  /**
   * Handles the removal of the processes listeners before eviction
   * of an entire user (after a given period of inactivity)
   */
  user_evict = function(user) {
    if(typeof my.users[user] !== 'undefined') {
      for(p in my.users[user]) {
        // so that all stats keep in synch with the process through
        // eventual commit. When user is evicted, all stats should
        // be evicted as well so that a new query on a stat will 
        // force the creation of th user again
        my.stat_cache.invalidate(new RegExp('^' + user + ':' + p));

        my.users[user][p].removeAllListeners();
        delete my.users[user][p];
      }
      //console.log('EVICT: ' + user);
      delete my.users[user];
    }
  };


  /**
   * Called every minutes, the user_crond method calls commit on users
   * and evicts users that have been inactive for a given period
   */
  user_crond = function() {
    var now = Date.now();
    var u_count = 0, p_count = 0, s_count = 0;
    for(var u in my.users) {
      var last = 0;
      for(var p in my.users[u]) {
        if(my.users[u][p].last() > last) {
          last = my.users[u][p].last();
        }
        my.users[u][p].commit();
      }
      if((now - last) > my.cfg['DATTSS_USER_EVICTION_PERIOD']) {
        user_evict(u);
      } 
      else {
        u_count++;
        for(var p in my.users[u]) {
          p_count++;
          s_count += my.users[u][p].count();
        }
      }
    }
    /* DaTtSs */ my.dts.srv.agg('active.user', u_count + 'g');
    /* DaTtSs */ my.dts.srv.agg('active.process', p_count + 'g');
    /* DaTtSs */ my.dts.srv.agg('active.stat', s_count + 'g');
    /* DaTtSs */ my.dts.srv.agg('active.cache', my.stat_cache.count() + 'g');
  };

  /**
   * `user_crond` interval call every minute
   */
  my.itv = setInterval(user_crond, my.cfg['DATTSS_USER_CROND_PERIOD']);

  /**
   * Retrieves the current user (actually its list of processes) that are
   * still on disk in its `current` directory and put them in memory, or
   * directly return them if they where alread loaded
   * @param user the user name or email
   * @param cb(err, u) callback with error reporting
   */
  user_get = function(user, cb) {
    var now = Date.now();

    var done = function(u) {
      /* DaTtSs */ my.dts.srv.agg('eng.user_get', (Date.now() - now) + 'ms');
      /* DaTtSs */ my.dts.srv.agg('eng.user_get', '1c');
      cb(null, u);
    };
    
    if(typeof my.users[user] === 'undefined') {
      my.users[user] = {};
      fs.readdir(my.cfg['DATTSS_STORAGE_PATH'] + '/' + user + '/current', 
                 function(err, files) {
                   if(err) {
                     if(err.code !== 'ENOENT') {
                       cb(err);
                     }
                     else {
                       // user does not exist yet
                       done(my.users[user]);
                     }
                   }
                   else {
                     var mplex = fwk.mplex({});
                     files.forEach(function(f) {
                       if(f.substr(-4,4) === '.cur') {
                         var name = f.substr(0, f.length-4);
                         var mcb = mplex.callback();
                         console.log('PROCES RETRIEVED: ' + user + ' ' + name);
                         process_init(user, name, function(err, p) {
                           if(err) {
                             console.log('ERROR: [engine] `user_get`: ' +
                                         'Load failed for ' + user + ':' + name);
                             console.log(err);
                           }
                           else {
                             my.users[user][name] = p;
                           }
                           mcb();
                         });
                       }
                     });
                     mplex.go(function() {
                       done(my.users[user]);
                     });
                   }
      });
    }
    else {
      done(my.users[user]);
    }
  };


  /*********************************************
   *  PUBLIC FUNCTIONS                         *
   *********************************************/

  /**
   * Partial aggregation function. Receives partial aggregates from a
   * given process and updates the current state and minute partial agg.
   * A partial aggregate *MUST HAVE* the following format:
   * data = { nam: "core",
   *          upt: 123123,
   *          mem: 13996032,
   *          prt: { 'c': [{ typ: 'c',
   *                         nam: 'new'
   *                         sum: 376,
   *                         cnt: 340,
   *                         max: 3,
   *                         min: 1,
   *                         top: 3,
   *                         bot: 1,
   *                         fst: 1,
   *                         lst: 1 }],
   *                 'ms': [{ typ: 'g', 
   *                          nam: 'cache',
   *                          sum: 990,          
   *                          cnt: 45,
   *                          max: 23,
   *                          min: 21,
   *                          top: 23,
   *                          bot: 22,
   *                          fst: 23,
   *                          lst: 22 }],
   *                 'g': [{ typ: 'ms',
   *                         nam: 'view',
   *                         sum: 5670,
   *                         cnt: 45,
   *                         max: 1240,
   *                         min: 9,
   *                         top: 500,
   *                         bot: 34,
   *                         fst: 456,
   *                         lst: 123 }] 
   *            } 
   *         };   
   * 5s-partial aggregates are calculated client side and aggregated
   * (with approximation) server side to build sliding 1mn-partial 
   * aggregates to be stored on disk every 1mn. 
   */
  agg = function(user, data) {
    var now = Date.now();

    // normalization
    if(typeof data.nam !== 'string' ||
       typeof data.upt !== 'number' ||
       typeof data.prt === 'undefined' ||
       !Array.isArray(data.prt.c) ||
       !Array.isArray(data.prt.ms) ||
       !Array.isArray(data.prt.g)) {
         return false;
    }
    if(!/^([A-Za-z0-9\-\_\.\:]+)$/.exec(data.nam))
      return false;
    data.prt.c.forEach(function(prt) {
      if(!/^([A-Za-z0-9\-\_\.\:]+)$/.exec(prt.nam))
        return false;
    });
    data.prt.ms.forEach(function(prt) {
      if(!/^([A-Za-z0-9\-\_\.\:]+)$/.exec(prt.nam))
        return false;
    });
    data.prt.g.forEach(function(prt) {
      if(!/^([A-Za-z0-9\-\_\.\:]+)$/.exec(prt.nam))
        return false;
    });
    
    var done = function(p) {
      p.agg(data);
      //console.log(util.inspect(p.current(), false, 10));
      //console.log('--------------------------------------------');
      /* DaTtSs */ my.dts.srv.agg('eng.agg', (Date.now() - now) + 'ms');
      /* DaTtSs */ my.dts.srv.agg('eng.agg', '1c!');
    };

    // init user/process and aggregate
    user_get(user, function(err, u) {
      if(err) {
        console.log('ERROR: [engine] `agg`: ' + 
                    'Load failed for ' + user);
        console.log(err);
      }
      else {
        if(typeof u[data.nam] !== 'undefined') {
          done(u[data.nam]);
        }
        else {
          process_init(user, data.nam, function(err, p) {
            if(err) {
              console.log('ERROR: [engine] `agg`: ' + 
                          'Init failed for ' + user + ':' + data.nam);
              console.log(err);
            }
            else {
              console.log('PROCESS CREATED: ' + user + ' ' + data.nam);
              my.users[user][data.nam] = p;
              done(p);
            }
          });
        }
      }
    });

    return true;
  };
  

  /**
   * The current state of an user is dictionary for each app that the
   * user have live which cotains the folowing information:
   * current['core'] = { nam: "core",
   *                     upt: 123123,
   *                     lst: 2123,
   *                     sts: { 'c': [{ typ: 'c',
   *                                    nam: 'new',
   *                                    sum: 534869,
   *                                    avg: 75.37 }],
   *                            'g': [{ typ: 'g',
   *                                    nam: 'cache',
   *                                    lst: 22,
   *                                    dlt: -2.23 },
   *                                  { typ: 'g',
   *                                    nam: 'clients',
   *                                    lst: 123,
   *                                    dlt: 3.23 }],
   *                            'ms': [{ typ: 'ms',
   *                                     nam: 'view',
   *                                     avg: 126.34,
   *                                     max: 1547,
   *                                     min: 67 }] 
   *                           } 
   *                      }; 
   * The current data is calculated by each process object and stored
   * every minute on the disk in case of restart. The current data is 
   * calculated from the 5s-partial aggregate it receives.
   * @param user the user to look current values from
   * @param cb(err, cur)
   */
  current = function(user, cb) {
    var now = Date.now()
    user_get(user, function(err, u) {
      if(err) {
        cb(err);
      }
      else {
        var cur = {};
        for(var p in u) {
          cur[p] = u[p].current(); 
        }
        /* DaTtSs */ my.dts.srv.agg('eng.current', (Date.now() - now) + 'ms');
        /* DaTtSs */ my.dts.srv.agg('eng.current', '1c');
        cb(null, cur, (Date.now() - now));
      }
    });
  };

  /**
   * Retrieves the historical data from the disk and aggregate it with
   * the help of the stat object. Stats are not cached, they are just
   * loaded up in memory through the stat object and aggregated on the
   * fly
   * @param user the user to compute the stat from
   * @param process the process name to compute the state for
   * @param type the stat type
   * @param name the stat name
   * @param offset the timezone offset in minutes
   * @param cb(err, st, took) the callback
   */
  var stat = function(user, process, type, name, offset, cb) {
    var now = Date.now();

    var stat_getter = function(key, cb) {
      user_get(user, function(err, u) {
        if(err) {
          cb(err);
        }
        else {
          if(typeof u[process] !== undefined) {
            u[process].stat(type, name, function(err, stat) {
              if(err) {
                cb(err);
              }
              else {
                u[process].on(type + ':' + name + ':commit', stat.commit);
                cb(null, stat);
              }
            });
          }
          else {
            cb(new Error('Unknown process for user ' + user + ': ' + process));
          }
        }
      });
    };

    var stat_evict = function(key, stat) {
      if(my.users[user] && my.users[user][process]) {
        my.users[user][process].removeListener(type + ':' + name + ':commit', stat.commit);
      }
    };

    my.stat_cache.get(user + ':' + process + ':' + type + ':' + name,
                      { getter: stat_getter,
                        evict: stat_evict,
                        timeout: my.cfg['DATTSS_STAT_CACHE_TIMEOUT'] },
                      function(err, stat) {
                        var st = stat.compute_day(10, offset);
                        var took = (Date.now() - now);
                        /* DaTtSs */ my.dts.srv.agg('eng.stat', '1c');
                        /* DaTtSs */ my.dts.srv.agg('eng.stat', took + 'ms');
                        cb(null, st, took);
                      });
  };

  /**
   * Removes a process from a user current object so that offline
   * processes can be reclaimed. This method does not delete historical
   * partial-aggregates it only impacts current.
   * @param user the user to delete the process from
   * @param process the process to destroy
   * @param cb(err) the callback
   */
  var destroy = function(user, process, cb) {
    var now = Date.now();
    user_get(user, function(err, u) {
      if(err) {
        cb(err);
      }
      else {
        for(var p in u) {
          if(p === process) {
            u[p].removeAllListeners('update');
            u[p].destroy();
            delete u[p];
            cb();
            return;
          }
        }
        cb(new Error('process ' + user + ':' + process + ' not found'));
      }
    });
  };

  
  fwk.method(that, 'agg', agg, _super);
  fwk.method(that, 'current', current, _super);
  fwk.method(that, 'stat', stat, _super);
  fwk.method(that, 'destroy', destroy, _super);

  return that;
};

exports.engine = engine;
