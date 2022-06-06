# Meteor.js

We maintain a custom package build specifically for [Meteor.js](https://docs.meteor.com/). Learn how to install and use it within [Meteor Framework](https://meteor.com)

## Meteor.js usage:

Mail-Time package can be installed and used within [Meteor.js](https://docs.meteor.com/) via [NPM](https://www.npmjs.com/package/mail-time) or [Atmosphere](https://atmospherejs.com/ostrio/mailer)

### Installation & Import (*via Atmosphere*):

Install [Atmosphere `ostrio:mailer` package](https://atmospherejs.com/ostrio/mailer):

```shell
meteor add ostrio:mailer
```

Meteor.js: ES6 Import atmosphere package:

```js
import MailTime from 'meteor/ostrio:mailer';
```

### Installation & Import (*via NPM*):

Install [NPM `mail-time` package](https://www.npmjs.com/package/mail-time):

```shell
meteor npm install --save mail-time
```

Meteor.js: ES6 Import NPM package:

```js
import MailTime from 'mail-time';
```

### Examples:

`mail-time` package usage examples in Meteor.js

```js
import { MongoInternals } from 'meteor/mongo';

import MailTime from 'mail-time';
import nodemailer from 'nodemailer';
// Use DIRECT transport
// To enable sending email from localhost
// install "nodemailer-direct-transport" NPM package:
import directTransport from 'nodemailer-direct-transport';

const transports = [];
const directTransportOpts = {
  pool: false,
  direct: true,
  name: 'mail.example.com',
  from: 'no-reply@example.com',
};
transports.push(nodemailer.createTransport(directTransport(directTransportOpts)));
// IMPORTANT: Add `.options` to a newly created transport,
// this is necessary to make sure options are available to MailTime package:
transports[0].options = directTransportOpts;

////////////////////////
// See sections above and read nodemailer's docs for `transports` examples
////////////////////////

const mailQueue = new MailTime({
  db: MongoInternals.defaultRemoteCollectionDriver().mongo.db, // MongoDB
  transports,
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return `"Awesome App" <${transport.options.from}>`;
  }
});
```

## Testing

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

Test Atmosphere (meteor.js) package:

```shell
# Default
EMAIL_DOMAIN="example.com" meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
DEBUG="true" EMAIL_DOMAIN="example.com" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB and custom port
DEBUG="true" EMAIL_DOMAIN="example.com" MONGO_URL="mongodb://127.0.0.1:27017/meteor-mail-time-test-001" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 2 mins
```
