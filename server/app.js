var express = require('express')
  , app = express()
  , _ = require('underscore')
  , emptyFunction = require('authbox-common/emptyFunction')
  , crypto = require('crypto')
  , exec = require('child_process').exec
  , fs = require('fs')
  , mixpanel = require('mixpanel')
  , redis = require('redis-url').connect()
  , request = require('request')
  , spawn = require('child_process').spawn
  , text = require('../lib/text')
  , uuid = require('uuid');

// Express config
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');

app.use(express.cookieParser());
app.use(express.static(__dirname + '/public'));
app.use(express.bodyParser());

// Enable log messages when sending texts.
text.debug(true);

// Optional modules
var banned_numbers;
try {
  banned_numbers = require('./banned_numbers.js');
} catch(e) {
  banned_numbers = {BLACKLIST: {}};
}

var mpq
  , mixpanel_config
  , smyte
  , smyte_config;
try {
  mixpanel_config = require('./mixpanel_config.js');
  mpq = new mixpanel.Client(mixpanel_config.api_key);
} catch(e) {
  mpq = {track: function() {}};
}

try {
  smyte_config = require('./authbox_config.js');
  smyte = {
    log: function(action, object, cb) {
      cb = cb || emptyFunction.thatReturnsArgument;
      action = action || {}
      object = object || null;
      var data = {
        PUT: {},
        POST: {},
      };

      if (object) {
        var text_id = uuid.v4();
        data.PUT['/object/text/' + text_id] = object;
        action.data = {
          text_id: text_id,
          recipient_id: object.recipient || null
        };
      }
      data.POST['/action'] = [action];

      request
        .post('https://api.smyte.com/v2/batch')
        .auth(smyte_config.apiKey, smyte_config.secretKey)
        .set('Content-Type', 'application/json')
        .send(data)
        .end(cb);
    }
  };
} catch(e) {
  smyte = {
    log: function(body, object, cb) {
      cb = cb || emptyFunction.thatReturnsArgument;
      cb();
    }
  };
}

var access_keys;
try {
  // Optionally, you may specify special access keys in a keys.json file.
  // These access keys are not rate-limited.
  // See example_keys.json for format.
  access_keys = require('./keys.json');
} catch (e) {
  access_keys = {};
}

// App routes
app.get('/', function(req, res) {
  fs.readFile(__dirname + '/views/index.html', 'utf8', function(err, text){
    res.send(text);
  });
});

app.get('/providers/:region', function(req, res) {
  // Utility function, just to check the providers currently loaded
  res.send(providers[req.params.region]);
});

app.post('/text', function(req, res) {
  var number = stripPhone(req.body.number);
  if (number.length < 9 || number.length > 10) {
    res.send({success:false, message:'Invalid phone number.'});
    return;
  }
  textRequestHandler(req, res, number, 'us', req.query.key);
});

app.post('/canada', function(req, res) {
  textRequestHandler(req, res, stripPhone(req.body.number), 'canada', req.query.key);
});

app.post('/intl', function(req, res) {
  textRequestHandler(req, res, stripPhone(req.body.number), 'intl', req.query.key);
});

// App helper functions

function textRequestHandler(req, res, number, region, key) {
  var ip = req.connection.remoteAddress;
  if (!ip || ip === '127.0.0.1') {
    ip = req.header('X-Real-IP');
  }

  var smyte_action = {
    name: 'text',
    http_request: {
      network: {
        remote_address: ip
      },
    },
  };

  if (!number || !req.body.message) {
    mpq.track('incomplete request');
    smyte.log(_.extend(smyte_action, {failure_code: 'incomplete_request'}));
    res.send({success:false, message:'Number and message parameters are required.'});
    return;
  }

  var message = req.body.message;
  if (message.indexOf(':') > -1) {
    // Handle problem with vtext where message would not get sent properly if it
    // contains a colon.
    message = ' ' + message;
  }

  var smyte_object = {};
  var shasum = crypto.createHash('sha1');
  shasum.update(number);
  var smyte_digest = shasum.digest('hex');
  _.extend(smyte_object, {
    recipient: smyte_digest,
    message: message
  });

  if (banned_numbers.BLACKLIST[number]) {
    mpq.track('banned number');
    smyte.log(_.extend(smyte_action, {failure_code: 'banned_number'}), smyte_object);
    res.send({success:false,message:'Sorry, texts to this number are disabled.'});
    return;
  }

  var tracking_details = {
    number: number,
    message: req.body.message,
    ip: ip
  };

  var doSendText = function(response_obj) {
    response_obj = response_obj || {};

    // Time to actually send the message
    text.send(number, message, region, function(err) {
      if (err) {
        mpq.track('sendText failed', tracking_details);
        smyte.log(_.extend(smyte_action, {failure_code: 'gateway_failed'}), smyte_object);
        res.send(_.extend(response_obj,
                          {
                            success:false,
                            message:'Communication with SMS gateway failed.'
                          }));
      }
      else {
        smyte.log(smyte_action, smyte_object, function(response) {
          response = response || {};
          var actionResponse = (response.body || {}).POST || {};
          if ((actionResponse['/action'] || {}).statusCode === 403) {
            mpq.track('blocked by smyte', tracking_details);
            res.send(_.extend(response_obj, {success:false, message:'Unable to send.'}));
          } else {
            mpq.track('sendText success', tracking_details);
            res.send(_.extend(response_obj, {success:true}));
          }
        });
      }
    });
  };

  // Do they have a valid access key?
  if (key && key in access_keys) {
    console.log('Got valid key', key, '... not applying limits.');
    // Skip verification
    mpq.track('sendText skipping verification', _.extend(tracking_details, {
      key: key,
    }));
    doSendText({used_key: key});
    return;
  }

  // If they don't have a special key, apply rate limiting and verification
  var ipkey = 'textbelt:ip:' + ip + '_' + dateStr();
  var phonekey = 'textbelt:phone:' + number;

  redis.incr(phonekey, function(err, num) {
    if (err) {
      mpq.track('redis fail');
      res.send({success:false, message:'Could not validate phone# quota.'});
      return;
    }

    setTimeout(function() {
      redis.decr(phonekey, function(err, num) {
        if (err) {
          mpq.track('failed to decr phone quota', {number: number});
          console.log('*** WARNING failed to decr ' + number);
        }
      });
    }, 1000*60*3);
    if (num > 3) {
      mpq.track('exceeded phone quota');
      smyte.log(_.extend(smyte_action, {failure_code: 'exceeded_phone_quota'}), smyte_object);
      res.send({success:false, message:'Exceeded quota for this phone number. ' + number});
      return;
    }

    // now check against ip quota
    redis.incr(ipkey, function(err, num) {
      if (err) {
        mpq.track('redis fail');
        res.send({success:false, message:'Could not validate IP quota.'});
        return;
      }
      if (num > 75) {
        mpq.track('exceeded ip quota');
        smyte.log(_.extend(smyte_action, {failure_code: 'exceeded_ip_quota'}), smyte_object);
        res.send({success:false, message:'Exceeded quota for this IP address. ' + ip});
        return;
      }
      setTimeout(function() {
        redis.decr(ipkey, function(err, num) {
          if (err) {
            mpq.track('failed to decr ip key', {ipkey: ipkey});
            console.log('*** WARNING failed to decr ' + ipkey);
          }
        });
      }, 1000*60*60*24);

      // Cleared to send now
      doSendText();
    });     // end redis ipkey incr
  });       // end redis phonekey incr
}           // end textRequestHandler

function dateStr() {
  var today = new Date();
  var dd = today.getDate();
  var mm = today.getMonth()+1;
  var yyyy = today.getFullYear();
  return mm + '/' + dd + '/' + yyyy;
}

function stripPhone(phone) {
  return (phone + '').replace(/\D/g, '');
}

// Start server
var port = process.env.PORT || 9090;
app.listen(port, function() {
  console.log('Listening on', port);
});
