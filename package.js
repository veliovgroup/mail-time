Package.describe({
  name: 'ostrio:mailer',
  version: '4.1.0',
  summary: '📮 Email queue extending nodemailer with multi-SMTP transports and horizontally scaled apps support',
  git: 'https://github.com/veliovgroup/mail-time',
  documentation: 'README.md'
});

Package.onUse((api) => {
  Npm.depends({
    josk: '6.2.0',
  });

  api.versionsFrom(['2.14', '3.2']);
  api.use([
    'ecmascript',
    'mongo',
    'zodern:types@1.0.13',
  ], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    chai: '6.2.2',
    pg: '8.20.0',
    redis: '5.12.1',
  });

  api.use([
    'ecmascript',
    'mongo',
    'meteortesting:mocha@1.2.0 || 2.1.0 || 3.2.0',
  ], 'server');
  api.addFiles('test/meteor.js', 'server');
});
