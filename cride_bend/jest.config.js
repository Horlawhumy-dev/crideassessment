/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: [
    'src/**/*.ts',
    // Composition roots and adapters are exercised by e2e against real
    // infrastructure; a unit-coverage number over them would be theatre.
    '!src/**/main.ts',
    '!src/**/worker.ts',
    '!src/**/*.module.ts',
    '!src/**/infrastructure/**',
    '!src/**/platform/**',
  ],
  coverageThreshold: {
    // Only the pure core is held to a number, and only because it is the part
    // that can be tested exhaustively.
    './src/rides/domain/': { statements: 90, branches: 85, functions: 90, lines: 90 },
    './src/kernel/': { statements: 85, branches: 80, functions: 85, lines: 85 },
  },
  clearMocks: true,
  restoreMocks: true,
};
