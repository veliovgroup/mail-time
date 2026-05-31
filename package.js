Package.describe({
  name: 'ostrio:mailer',
  version: '4.0.0',
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
    'ecmascript@0.14.0 || 0.16.0',
    'mongo@1.10.0 || 1.16.0 || 2.0.4',
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
    'ecmascript@0.14.0 || 0.16.0',
    'mongo@1.10.0 || 1.16.0 || 2.0.4',
    'meteortesting:mocha@1.2.0 || 2.1.0 || 3.2.0',
  ], 'server');
  api.addFiles('test/meteor.js', 'server');
});
