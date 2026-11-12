import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `wrangler pages dev` serves the /api functions on :8788 by default.
const API_TARGET = process.env.HONGBAO_API ?? 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [react()],
  server: {
    // src imports ../config/*.json and ../shared/*.json from the repo root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    // integration/ imports both src/ and functions/ (Workers types), so it sits
    // outside the app's tsconfig; it only runs against a fork (see the file header).
    include: ['src/**/*.test.ts', 'integration/**/*.test.ts'],
    // The fork suites share one chain (and stats/ledger counts), so files run one at a time.
    fileParallelism: false,
  },
});
