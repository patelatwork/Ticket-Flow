import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

// The browser only ever talks to its own origin: /api is proxied to the API (same as nginx
// in production), so the refresh cookie stays first-party.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // The API scopes its refresh cookie to /auth; in the browser that path is /api/auth.
        cookiePathRewrite: { '/auth': '/api/auth' },
      },
      // Bull Board (admin) lives at the same path on both sides.
      '/admin/queues': { target: apiTarget, changeOrigin: true },
    },
  },
});
