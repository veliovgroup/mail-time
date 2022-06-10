Package.describe({
  name: 'ostrio:mailer',
  version: '2.4.2',
  summary: 'Bulletproof email queue on top of NodeMailer for a single and multi-server setups',
  git: 'https://github.com/veliovgroup/mail-time',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom('1.6');
  api.use(['mongo', 'ecmascript'], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  api.use(['ecmascript', 'mongo', 'practicalmeteor:chai', 'meteortesting:mocha'], 'server');
  api.addFiles('test/meteor.js', 'server');
});

Npm.depends({
  josk: '3.0.1',
  deepmerge: '4.2.2'
});
