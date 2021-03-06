/******************************/
/*   CURRENT CELL               */
/******************************/
var current_c = function(spec, my) {
  var _super = {};
  my = my || {};

  my.process = {};

  // public
  var build;   /* build(); */
  var refresh; /* refresh(); */

  // private
  var process; /* process(name); */

  var that = CELL.cell(spec, my);

  /**
   * Retrives a process cell from the local object cache or construct
   * it if not found
   * @param name the process name
   * @return process the process cell
   */
  process = function(name) {
    if(!my.process[name]) {
      my.process[name] = process_c({ path: my.path + '/' + name,
                                     container: my.container,
                                     name: name });
      my.children[name] = my.process[name];
      my.process[name].on('close', function() {
        delete my.process[name];
        delete my.children[name];
      });
      my.process[name].build();
    }
    return my.process[name];
  };

  /****************************/
  /*   BUILD                  */
  /****************************/
  build = function() {
    my.element = $('<table/>').addClass('dattss-current');
    return my.element;
  };

  /****************************/
  /*   REFRESH                */
  /****************************/
  /**
   * @expects { PROCESS_NAME: {PROCESS_OBJET} }
   */
  refresh = function(json) {
    my.element.empty();
    
    var ord = [];
    for(var name in json) {
      ord.push(name);
    }
    ord.sort().forEach(function(name) {
      var p = process(name);
      my.element.append(p.element());
    });
    if(ord.length === 0) {
      my.element.append($('<tr/>').addClass('tutorial')
          .append($('<td/>')
            .append('GOTO &nbsp;' +
                    '<strong>' + '<span class="pictos">i</span> Install' + '</strong>' +
                    '&nbsp; to get started')
            ));
    }

    _super.refresh(json);
  };

  
  CELL.method(that, 'build', build, _super);
  CELL.method(that, 'refresh', refresh, _super);

  return that;
};
