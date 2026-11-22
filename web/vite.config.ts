import { defineConfig } from 'vite';

export default defineConfig({
  // Served from https://app.sonora/ inside WebView2, so relative paths keep it portable.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: { port: 5173, strictPort: true },
});
