import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'shared',
      root: './packages/shared',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'backend-unit',
      root: './apps/backend',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'backend-integration',
      root: './apps/backend',
      include: ['test/**/*.test.ts'],
    },
  },
]);
