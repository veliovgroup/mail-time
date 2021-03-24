const JoSk   = require('josk');
const NoOp   = () =>  {};
const merge  = require('deepmerge');
const _debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info.call(console, '[DEBUG] [mail-time]', `${new Date}`, ...args);
  }
};
const _logError = (...args) => {
  console.error.call(console, '[ERROR] [mail-time]', `${new Date}`, ...args);
};

const mongoErrorHandler = (error) => {
  if (error) {
    _logError('[mongoErrorHandler]:', error);
    console.trace();
  }
};

let equals;
equals = (a, b) => {
  let i;
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  if (!(typeof a === 'object' && typeof b === 'object')) {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.valueOf() === b.valueOf();
  }

  if (a instanceof Array) {
    if (!(b instanceof Array)) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    const _a = a.slice();
    const _b = b.slice();
    let j;
    for (i = _a.length - 1; i >= 0; i--) {
      let result = false;
      for (j = _b.length - 1; j >= 0; j--) {
        if (equals(_a[i], _b[j])) {
          result = true;
          _a.splice(i, 1);
          _b.splice(j, 1);
          break;
        }
      }

      if (!result) {
        return false;
      }
    }
    return true;
  }

  i = 0;
  if (typeof a === 'object' && typeof b === 'object') {
    const akeys = Object.keys(a);
    const bkeys = Object.keys(b);

    if (akeys.length !== bkeys.length) {
      return false;
    }

    for (i = akeys.length - 1; i >= 0; i--) {
      if (!hasOwnProperty.call(b, akeys[i])) {
        return  false;
      }

      if (!equals(a[akeys[i]], b[akeys[i]])) {
        return false;
      }
    }

    return true;
  }
  return false;
};

let DEFAULT_TEMPLATE = '<!DOCTYPE html><html xmlns=http://www.w3.org/1999/xhtml><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><title>{{subject}}</title><style>body{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;font-family:Tiempos,Georgia,Times,serif;font-weight:400;width:100%;height:100%;background:#fff;font-size:15px;color:#000;line-height:1.5}a{text-decoration:underline;border:0;color:#000;outline:0;color:inherit}a:hover{text-decoration:none}a[href^=sms],a[href^=tel]{text-decoration:none;color:#000;cursor:default}a img{border:none;text-decoration:none}td{font-family:Tiempos,Georgia,Times,serif;font-weight:400}hr{height:1px;border:none;width:100%;margin:0;margin-top:25px;margin-bottom:25px;background-color:#ECECEC}h1,h2,h3,h4,h5,h6{font-family:HelveticaNeue,"Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:300;line-height:normal;margin-top:35px;margin-bottom:4px;margin-left:0;margin-right:0}h1{margin:23px 15px;font-size:25px}h2{margin-top:15px;font-size:21px}h3{font-weight:400;font-size:19px;border-bottom:1px solid #ECECEC}h4{font-weight:400;font-size:18px}h5{font-weight:400;font-size:17px}h6{font-weight:600;font-size:16px}h1 a,h2 a,h3 a,h4 a,h5 a,h6 a{text-decoration:none}pre{font-family:Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;display:block;font-size:13px;padding:9.5px;margin:0 0 10px;line-height:1.42;color:#333;word-break:break-all;word-wrap:break-word;background-color:#f5f5f5;border:1px solid #ccc;border-radius:4px;text-align:left!important;max-width:100%;white-space:pre-wrap;width:auto;overflow:auto}code{font-size:13px;font-family:font-family: Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;border:1px solid rgba(0,0,0,.223);border-radius:2px;padding:1px 2px;word-break:break-all;word-wrap:break-word}pre code{padding:0;font-size:inherit;color:inherit;white-space:pre-wrap;background-color:transparent;border:none;border-radius:0;word-break:break-all;word-wrap:break-word}td{text-align:center}table{border-collapse:collapse!important}.force-full-width{width:100%!important}</style><style media=screen>@media screen{h1,h2,h3,h4,h5,h6{font-family:\'Helvetica Neue\',Arial,sans-serif!important}td{font-family:Tiempos,Georgia,Times,serif!important}code,pre{font-family:Consolas,Menlo,Monaco,\'Lucida Console\',\'Liberation Mono\',\'DejaVu Sans Mono\',\'Bitstream Vera Sans Mono\',\'Courier New\',monospace,sans-serif!important}}</style><style media="only screen and (max-width:480px)">@media only screen and (max-width:480px){table[class=w320]{width:100%!important}}</style><body bgcolor=#FFFFFF class=body style=padding:0;margin:0;display:block;background:#fff;-webkit-text-size-adjust:none><table cellpadding=0 cellspacing=0 width=100% align=center><tr><td align=center valign=top bgcolor=#FFFFFF width=100%><center><table cellpadding=0 cellspacing=0 width=600 style="margin:0 auto"class=w320><tr><td align=center valign=top><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto;border-bottom:1px solid #ddd"bgcolor=#ECECEC><tr><td><h1>{{{subject}}}</h1></table><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"bgcolor=#F2F2F2><tr><td><center><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"><tr><td align=left style="text-align:left;padding:30px 25px">{{{html}}}</table></center></table></table></center></table>';

module.exports = class MailTime {
  constructor (opts) {
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into MailTime constructor');
    }

    if (!opts.db) {
      throw new Error('[mail-time] MongoDB database {db} option is required, like returned from `MongoClient.connect`');
    }

    this.callbacks  = {};
    this.type       = (!opts.type || (opts.type !== 'client' && opts.type !== 'server')) ? 'server' : opts.type;
    this.debug      = (opts.debug !== true) ? false : true;
    this.prefix     = opts.prefix || '';
    this.maxTries   = ((opts.maxTries && !isNaN(opts.maxTries)) ? parseInt(opts.maxTries) : 59) + 1;
    this.interval   = ((opts.interval && !isNaN(opts.interval)) ? parseInt(opts.interval) : 60) * 1000;
    this.template   = (typeof opts.template === 'string') ? opts.template : '{{{html}}}';
    this.zombieTime = opts.zombieTime || 32786;
    this.keepHistory = opts.keepHistory || false;

    this.revolvingInterval = opts.revolvingInterval || 1536;
    this.minRevolvingDelay = opts.minRevolvingDelay || 512;
    this.maxRevolvingDelay = opts.maxRevolvingDelay || 2048;

    if (this.interval < 2048 || isNaN(this.interval)) {
      this.interval = 3072;
    }

    if (this.zombieTime < 8192 || isNaN(this.zombieTime)) {
      this.zombieTime = 8192;
    }

    this.strategy    = (opts.strategy === 'backup' || opts.strategy === 'balancer') ? opts.strategy : 'backup';
    this.failsToNext = (opts.failsToNext && !isNaN(opts.failsToNext)) ? parseInt(opts.failsToNext) : 4;
    this.transports  = opts.transports || [];
    this.transport   = 0;
    this.from        = (() => {
      if (typeof opts.from === 'string') {
        return () => {
          return opts.from;
        };
      }

      if (typeof opts.from === 'function') {
        return opts.from;
      }

      return false;
    })();

    this.concatEmails     = (opts.concatEmails !== true) ? false : true;
    this.concatSubject    = (opts.concatSubject && typeof opts.concatSubject === 'string') ? opts.concatSubject : 'Multiple notifications';
    this.concatDelimiter  = (opts.concatDelimiter && typeof opts.concatDelimiter === 'string') ? opts.concatDelimiter : '<hr>';
    this.concatThrottling = ((opts.concatThrottling && !isNaN(opts.concatThrottling)) ? parseInt(opts.concatThrottling) : 60) * 1000;

    if (this.concatThrottling < 2048) {
      this.concatThrottling = 3072;
    }

    _debug(this.debug, 'DEBUG ON {debug: true}');
    _debug(this.debug, `INITIALIZING [type: ${this.type}]`);
    _debug(this.debug, `INITIALIZING [strategy: ${this.strategy}]`);
    _debug(this.debug, `INITIALIZING [prefix: ${this.prefix}]`);
    _debug(this.debug, `INITIALIZING [maxTries: ${this.maxTries}]`);
    _debug(this.debug, `INITIALIZING [failsToNext: ${this.failsToNext}]`);

    if (opts.type === 'server' && (this.transports.constructor !== Array || !this.transports.length)) {
      throw new Error('[mail-time] transports is required and must be an Array, like returned from `nodemailer.createTransport`');
    }

    this.collection = opts.db.collection('__mailTimeQueue__' + this.prefix);
    this.collection.createIndex({ to: 1, isSent: 1 }, (indexError) => {
      if (indexError) {
        _logError('[createIndex]', indexError);
      }
    });
    this.collection.createIndex({ sendAt: 1, isSent: 1, tries: 1 }, { background: true }, (indexError) => {
      if (indexError) {
        _logError('[createIndex]', indexError);
      }
    });
    // Schema:
    // _id
    // to          {String|[String]}
    // tries       {Number}  - qty of send attempts
    // sendAt      {Date}    - When letter should be sent
    // isSent      {Boolean} - Email status
    // template    {String}  - Template for this email
    // transport   {Number}  - Last used transport
    // concatSubject {String|Boolean} - Email concatenation subject
    // ---
    // mailOptions         {[Object]}  - Array of nodeMailer's `mailOptions`
    // mailOptions.to      {String|Array} - [REQUIRED]
    // mailOptions.from    {String}
    // mailOptions.text    {String|Boolean}
    // mailOptions.html    (String)
    // mailOptions.subject {String}
    // mailOptions.Other nodeMailer `sendMail` options...

    if (this.type === 'server') {
      this.scheduler = new JoSk({
        db: opts.db,
        debug: this.debug,
        prefix: `mailTimeQueue${this.prefix}`,
        resetOnInit: false,
        zombieTime: this.zombieTime,
        minRevolvingDelay: this.minRevolvingDelay,
        maxRevolvingDelay: this.maxRevolvingDelay
      });

      this.scheduler.setInterval(this.___send.bind(this), this.revolvingInterval, `mailTimeQueue${this.prefix}`);
    }
  }

  static get Template() {
    return DEFAULT_TEMPLATE;
  }

  static set Template(newVal) {
    DEFAULT_TEMPLATE = newVal;
  }

  ___compileMailOpts(transport, task) {
    let _mailOpts = {};

    if (!transport) {
      throw new Error('[mail-time] [sendMail] [___compileMailOpts] transport not available or misconfiguration is in place!');
    }

    if (transport._options && typeof transport._options === 'object' && transport._options !== null && transport._options.mailOptions) {
      _mailOpts = merge(_mailOpts, transport._options.mailOptions);
    }

    if (transport.options && typeof transport.options === 'object' && transport.options !== null && transport.options.mailOptions) {
      _mailOpts = merge(_mailOpts, transport.options.mailOptions);
    }

    _mailOpts = merge(_mailOpts, {
      html: '',
      text: '',
      subject: ''
    });

    for (let i = 0; i < task.mailOptions.length; i++) {
      if (task.mailOptions[i].html) {
        if (task.mailOptions.length > 1) {
          _mailOpts.html += this.___render(this.concatDelimiter, task.mailOptions[i]) + this.___render(task.mailOptions[i].html, task.mailOptions[i]);
        } else {
          _mailOpts.html = this.___render(task.mailOptions[i].html, task.mailOptions[i]);
        }
        delete task.mailOptions[i].html;
      }

      if (task.mailOptions[i].text) {
        if (task.mailOptions.length > 1) {
          _mailOpts.text += '\r\n' + this.___render(task.mailOptions[i].text, task.mailOptions[i]);
        } else {
          _mailOpts.text = this.___render(task.mailOptions[i].text, task.mailOptions[i]);
        }
        delete task.mailOptions[i].text;
      }

      _mailOpts = merge(_mailOpts, task.mailOptions[i]);
    }

    if (_mailOpts.html && (task.template || this.template)) {
      _mailOpts.html = this.___render((task.template || this.template), _mailOpts);
    }

    if (task.mailOptions.length > 1) {
      _mailOpts.subject = task.concatSubject || this.concatSubject || _mailOpts.subject;
    }

    if (!_mailOpts.from && this.from) {
      _mailOpts.from = this.from(transport);
    }

    return _mailOpts;
  }

  /*
   @memberOf MailTime
   @name ___send
   @param ready {Function} - See JoSk NPM package
   @returns {void}
   */
  ___send(ready) {
    let finished = 0;
    const cursor = this.collection.find({
      isSent: false,
      sendAt: {
        $lte: new Date()
      },
      tries: {
        $lt: this.maxTries
      }
    }, {
      projection: {
        _id: 1,
        tries: 1,
        template: 1,
        transport: 1,
        mailOptions: 1,
        concatSubject: 1
      }
    });

    cursor.count((countError, count) => {
      if (countError) {
        ready();
        cursor.close();
        _logError('[___send] [count] [countError]', countError);
        return;
      }

      if (count) {
        cursor.forEach((task) => {
          this.collection.updateOne({
            _id: task._id
          }, {
            $set: {
              isSent: true
            },
            $inc: {
              tries: 1
            }
          }, (updateError) => {
            if (count === ++finished) {
              ready();
            }

            if (updateError) {
              this.___handleError(task, updateError, {});
            } else {
              let transport;
              let transportIndex;
              if (this.strategy === 'balancer') {
                this.transport = this.transport + 1;
                if (this.transport >= this.transports.length) {
                  this.transport = 0;
                }
                transportIndex = this.transport;
                transport = this.transports[this.transport];
              } else {
                transportIndex = task.transport;
                transport = this.transports[task.transport];
              }

              try {
                const _mailOpts = this.___compileMailOpts(transport, task);

                _debug(this.debug, '[sendMail] [sending] To:', _mailOpts.to);
                transport.sendMail(_mailOpts, (error, info) => {
                  if (error) {
                    this.___handleError(task, error, info);
                    return;
                  }

                  if (info.accepted && !info.accepted.length) {
                    this.___handleError(task, 'Message not accepted or Greeting never received', info);
                    return;
                  }

                  _debug(this.debug, `email successfully sent, attempts: #${task.tries}, transport #${transportIndex} to: `, _mailOpts.to);
                  if (this.keepHistory) {
                    this.___triggerCallbacks(void 0, task, info);
                  } else {
                    this.collection.deleteOne({ _id: task._id }, () => {
                      this.___triggerCallbacks(void 0, task, info);
                    });
                  }

                  return;
                });
              } catch (e) {
                _logError('Exception during runtime:', e);
                this.___handleError(task, e, {});
              }
            }
          });
        }, (forEachError) => {
          cursor.close();
          if (forEachError) {
            _logError('[___send] [forEach] [forEachError]', forEachError);
          }
        });
      } else {
        ready();
        cursor.close();
      }
    });
  }

  /*
   @memberOf MailTime
   @name send
   @description alias of `sendMail`
   @returns {void}
   */
  send(opts, callback) {
    this.sendMail(opts, callback);
  }

  /*
   @memberOf MailTime
   @name sendMail
   @param opts          {Object}   - Letter options with next properties:
   @param opts.sendAt   {Date}     - When email should be sent
   @param opts.template {String}   - Template string
   @param opts[key]     {mix}      - Other MailOptions according to NodeMailer lib documentation
   @param callback      {Function} - [OPTIONAL] Callback function
   @returns {void}
   */
  sendMail(opts = {}, callback = NoOp) {
    _debug(this.debug, '[sendMail] [attempt] To:', opts.to);
    if (!opts.html && !opts.text) {
      throw new Error('`html` nor `text` field is presented, at least one of those fields is required');
    }

    if (!opts.sendAt || Object.prototype.toString.call(opts.sendAt) !== '[object Date]') {
      opts.sendAt = new Date();
    }

    if (typeof opts.template !== 'string') {
      opts.template = false;
    }

    if (typeof opts.concatSubject !== 'string') {
      opts.concatSubject = false;
    }

    let _sendAt          = opts.sendAt;
    const _template      = opts.template;
    const _concatSubject = opts.concatSubject;
    delete opts.sendAt;
    delete opts.template;
    delete opts.concatSubject;

    if (typeof opts.to !== 'string' && (!(opts.to instanceof Array) || !opts.to.length)) {
      throw new Error('[mail-time] `mailOptions.to` is required and must be a string or non-empty Array');
    }

    if (this.concatEmails) {
      this.collection.findOne({
        to: opts.to,
        isSent: false,
        sendAt: {
          $lte: new Date(+_sendAt + this.concatThrottling)
        }
      }, {
        projection: {
          _id: 1,
          mailOptions: 1
        }
      }, (findError, task) => {
        if (findError) {
          _debug(this.debug, 'something went wrong, can\'t send email to: ', opts.to, findError);
          callback(findError, void 0, task);
          return;
        }

        if (task) {
          const queue = task.mailOptions || [];

          for (let i = 0; i < queue.length; i++) {
            if (equals(queue[i], opts)) {
              return;
            }
          }

          queue.push(opts);

          this.collection.updateOne({
            _id: task._id
          }, {
            $set: {
              mailOptions: queue
            }
          }, (updateError) => {
            if (updateError) {
              _debug('something went wrong, can\'t send email to: ', task.mailOptions[0].to, updateError);
              callback(updateError, void 0, task);
            }
          });

          return;
        }

        _sendAt = new Date(+_sendAt + this.concatThrottling);
        this.___addToQueue({
          sendAt: _sendAt,
          template: _template,
          mailOptions: opts,
          concatSubject: _concatSubject
        }, callback);
        return;
      });

      return;
    }

    this.___addToQueue({
      sendAt: _sendAt,
      template: _template,
      mailOptions: opts,
      concatSubject: _concatSubject
    }, callback);

    return;
  }

  /*
   @memberOf MailTime
   @name ___handleError
   @param task  {Object} - Email task record form Mongo
   @param error {mix}    - Error String/Object/Error
   @param info  {Object} - Info object returned from nodemailer
   @returns {void}
   */
  ___handleError(task, error, info) {
    if (!task) {
      return;
    }

    if (task.tries >= this.maxTries) {
      this.collection.deleteOne({
        _id: task._id
      }, (deleteError) => {
        _debug(this.debug, `Giving up trying send email after ${task.tries} attempts to: `, task.mailOptions[0].to, error, deleteError);
        this.___triggerCallbacks(error, task, info);
      });
    } else {
      let transportIndex = task.transport;

      if (this.strategy === 'backup' && (task.tries % this.failsToNext) === 0) {
        ++transportIndex;
        if (transportIndex > this.transports.length - 1) {
          transportIndex = 0;
        }
      }

      this.collection.updateOne({
        _id: task._id
      }, {
        $set: {
          isSent: false,
          sendAt: new Date(Date.now() + this.interval),
          transport: transportIndex
        }
      }, mongoErrorHandler);

      _debug(this.debug, `Next re-send attempt at ${new Date(Date.now() + this.interval)}: #${task.tries}/${this.maxTries}, transport #${transportIndex} to: `, task.mailOptions[0].to, error);
    }
  }

  /*
   @memberOf MailTime
   @name ___addToQueue
   @param opts               {Object}   - Letter options with next properties:
   @param opts.sendAt        {Date}     - When email should be sent
   @param opts.template      {String}   - Email template
   @param opts.mailOptions   {Object}   - MailOptions according to NodeMailer lib
   @param opts.concatSubject {String}   - Email subject used when sending multiple concatenated emails
   @param callback           {Function} - [OPTIONAL] Callback function
   @returns {void}
   */
  ___addToQueue(opts, callback) {
    _debug(this.debug, '[sendMail] [adding to queue] To:', opts.mailOptions.to);
    const task = {
      tries: 0,
      isSent: false,
      sendAt: opts.sendAt,
      template: opts.template,
      transport: this.transport,
      mailOptions: [opts.mailOptions],
      concatSubject: opts.concatSubject
    };

    if (this.concatEmails) {
      task.to = opts.mailOptions.to;
    }

    this.collection.insertOne(task, (insertError, r) => {
      if (insertError) {
        _logError('something went wrong, can\'t send email to: ', opts.mailOptions[0].to, insertError);
        callback(insertError, void 0, opts);
        return;
      }

      const _id = r.insertedId.toHexString();
      if (!this.callbacks[_id]) {
        this.callbacks[_id] = [];
      }
      this.callbacks[_id].push(callback);
      return;
    });
  }

  /*
   @memberOf MailTime
   @name ___render
   @param string       {String} - Template with Spacebars/Blaze/Mustache-like placeholders
   @param replacements {Object} - Blaze/Mustache-like helpers Object
   @returns {String}
   */
  ___render(_string, replacements) {
    let i;
    let string      = _string;
    const matchHTML = string.match(/\{{3}\s?([a-zA-Z0-9\-\_]+)\s?\}{3}/g);
    if (matchHTML) {
      for (i = 0; i < matchHTML.length; i++) {
        if (replacements[matchHTML[i].replace('{{{', '').replace('}}}', '').trim()]) {
          string = string.replace(matchHTML[i], replacements[matchHTML[i].replace('{{{', '').replace('}}}', '').trim()]);
        }
      }
    }

    const matchStr  = string.match(/\{{2}\s?([a-zA-Z0-9\-\_]+)\s?\}{2}/g);
    if (matchStr) {
      for (i = 0; i < matchStr.length; i++) {
        if (replacements[matchStr[i].replace('{{', '').replace('}}', '').trim()]) {
          string = string.replace(matchStr[i], replacements[matchStr[i].replace('{{', '').replace('}}', '').trim()].replace(/<(?:.|\n)*?>/gm, ''));
        }
      }
    }
    return string;
  }

  /*
   @memberOf MailTime
   @name ___triggerCallbacks
   @param error  {mix}    - Error thrown during sending email
   @param task   {Object} - Task record from mongodb
   @param info   {Object} - Info object returned from NodeMailer's `sendMail` method
   @returns {void 0}
   */
  ___triggerCallbacks(error, task, info) {
    const _id = task._id.toHexString();
    if (this.callbacks[_id] && this.callbacks[_id].length) {
      this.callbacks[_id].forEach((cb, i) => {
        cb(error, info, task.mailOptions[i]);
      });
    }
    delete this.callbacks[_id];
  }
};
