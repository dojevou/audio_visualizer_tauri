import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./src/tests/setup.ts'],
    alias: {
      // Force client-side Svelte for testing
      'svelte': 'svelte'
    },
    server: {
      deps: {
        inline: ['svelte']
      }
    }
  },
  resolve: {
    conditions: ['browser']
  }
});
