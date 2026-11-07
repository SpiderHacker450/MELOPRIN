import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pinkverseSecurityPlugin } = require('./server/vite-security-plugin.cjs');

const target = process.env.PINKVERSE_BUILD_TARGET || 'public';
const isExperience = target === 'experience';

export default defineConfig({
  plugins: [react(), pinkverseSecurityPlugin()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: isExperience ? 'storage/private_bundle' : 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: isExperience
        ? path.resolve(__dirname, 'experience.html')
        : path.resolve(__dirname, 'index.html'),
      output: {
        manualChunks: isExperience
          ? {
              animation: ['framer-motion', 'gsap'],
              icons: ['lucide-react', 'canvas-confetti'],
            }
          : undefined,
      },
    },
  },
});
