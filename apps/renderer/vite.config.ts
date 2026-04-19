import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Emit relative asset URLs. The packaged app loads index.html via file://,
  // where Vite's default absolute base (/) would resolve to the filesystem root
  // and 404 every asset.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:47120',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:47120',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
