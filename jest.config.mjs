export default {
  clearMocks: true,
  restoreMocks: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/jest/**/*.test.js'],
  testTimeout: 20000,
  collectCoverage: true,
  collectCoverageFrom: [
    'index.js',
    'presets.js',
    'adapters/*.js',
    '!adapters/blank-example.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85
    }
  },
  testPathIgnorePatterns: ['/node_modules/', '/.meteor/']
};
