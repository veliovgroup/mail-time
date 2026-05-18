Package.describe({
  name: 'ostrio:mailer',
  version: '4.0.0',
  summary: '📮 Email queue extending NodeMailer with multi-SMTP transports and horizontally scaled apps support',
  git: 'https://github.com/veliovgroup/mail-time',
  documentation: 'README.md'
});

Package.onUse((api) => {
  Npm.depends({
    josk: '6.0.0',
  });

  api.versionsFrom(['1.6', '3.0-beta.0']);
  api.use(['mongo@1.6.19 || 2.0.0-beta300.0', 'ecmascript@0.16.8 || 0.16.8-beta300.0'], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    chai: '6.2.2',
    pg: '8.20.0',
    redis: '5.12.1',
  });

  api.use(['ecmascript@0.16.8 || 0.16.8-beta300.0', 'mongo@1.6.19 || 2.0.0-beta300.0', 'meteortesting:mocha@2.1.0 || 3.1.0-beta300.0'], 'server');
  api.addFiles('test/meteor.js', 'server');
});
