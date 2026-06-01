Package.describe({
  name: 'ostrio:mailer',
  version: '4.1.0',
  summary: '📮 Email queue extending nodemailer with multi-SMTP transports and horizontally scaled apps support',
  git: 'https://github.com/veliovgroup/mail-time',
  documentation: 'README.md'
});

/**
 * Meteor test-packages runs package.js under each release's bundled Node.
 * @returns {{ npm: Record<string, string>, mocha: string }}
 */
const meteorTestProfile = () => {
  const nodeMajor = parseInt(String(process.versions.node).split('.')[0], 10);

  if (nodeMajor >= 20) {
    return {
      npm: {
        chai: '6.2.2',
        pg: '8.20.0',
        redis: '5.12.1',
      },
      mocha: 'meteortesting:mocha@3.3.0',
    };
  }

  if (nodeMajor >= 18) {
    return {
      npm: {
        chai: '5.3.3',
        redis: '4.7.1',
        pg: '8.16.3',
      },
      mocha: 'meteortesting:mocha@3.3.0',
    };
  }

  if (nodeMajor >= 14) {
    return {
      npm: {
        chai: '4.4.1',
        redis: '4.7.1',
        pg: '8.11.3',
      },
      mocha: 'meteortesting:mocha@2.1.0',
    };
  }

  throw new Error(`ostrio:mailer requires Node >= 14 (got ${process.version})`);
};

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
  const profile = meteorTestProfile();
  Npm.depends(profile.npm);

  api.use([
    'ecmascript',
    'mongo',
    profile.mocha,
  ], 'server');
  api.addFiles('test/meteor.js', 'server');
});
