import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The Postgres (PGlite) suites and the MUI interaction tests can each take several
    // seconds when the machine is busy; the 5s default made them fail at random.
    testTimeout: 30_000,
  },
})
