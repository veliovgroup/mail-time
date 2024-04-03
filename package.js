Package.describe({
  name: 'ostrio:mailer',
  version: '2.5.0',
  summary: 'Bulletproof email queue on top of NodeMailer for a single and multi-server setups',
  git: 'https://github.com/veliovgroup/mail-time',
  documentation: 'README.md'
});

Package.onUse((api) => {
  Npm.depends({
    josk: '3.1.1',
    deepmerge: '4.3.1',
  });

  api.versionsFrom(['1.6', '3.0-beta.0']);
  api.use(['mongo@1.6.19 || 2.0.0-beta300.0', 'ecmascript@0.16.8 || 0.16.8-beta300.0'], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  Npm.depends({
    deepmerge: '4.3.1',
    nodemailer: '6.9.12',
    'nodemailer-direct-transport': '3.3.2',
    chai: '4.4.1',
  });

  api.use(['ecmascript@0.16.8 || 0.16.8-beta300.0', 'mongo@1.6.19 || 2.0.0-beta300.0', 'meteortesting:mocha@2.1.0 || 3.1.0-beta300.0'], 'server');
  api.addFiles('test/meteor.js', 'server');
});
