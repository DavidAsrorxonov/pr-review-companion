import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  build: {
    // Keep the unpacked release usable while the development server is running.
    outDir: command === 'serve' ? 'dist-dev' : 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: { origin: [/^chrome-extension:\/\//] },
  },
}));
