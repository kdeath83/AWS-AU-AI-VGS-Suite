/**
 * tests/setup.ts
 * Jest setup file for the AWS AU AI VGS Suite.
 */

// Mock console methods to reduce noise during tests
// but still log errors
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('ERROR') || args[0].includes('Failed') || args[0].includes('error'))
  ) {
    originalConsoleError(...args);
  }
};
