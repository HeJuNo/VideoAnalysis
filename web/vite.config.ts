import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The API runs separately in development; the browser only ever talks to this origin.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
