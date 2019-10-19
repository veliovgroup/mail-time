Package.describe({
  name: 'ostrio:mailer',
  version: '2.3.0',
  summary: 'Bulletproof email queue on top of NodeMailer with support of multiple clusters and servers setup',
  git: 'https://github.com/VeliovGroup/Mail-Time',
  documentation: 'README.md'
});

Package.onUse((api) => {
  api.versionsFrom('1.6');
  api.use(['mongo', 'ecmascript'], 'server');
  api.mainModule('index.js', 'server');
});

Package.onTest((api) => {
  api.use('jquery', 'client');
  api.use(['ecmascript', 'accounts-base', 'ostrio:mailer', 'practicalmeteor:chai', 'meteortesting:mocha'], 'server');
  api.addFiles('test/meteor.js', 'server');
});

Npm.depends({
  'josk': '2.2.0',
  'deepmerge': '4.1.1'
});
