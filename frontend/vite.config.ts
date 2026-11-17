import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // API_PROXY_TARGET has no VITE_ prefix, so it is only visible here (Node side)
  // and is never bundled into browser code.
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.API_PROXY_TARGET || 'http://127.0.0.1:3000'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: 'localhost',
      port: 5173,
      // Fail instead of silently moving to another port: FRONTEND_URL in the
      // backend (Origin/CSRF checks) and the S3 bucket CORS rules expect 5173.
      strictPort: true,
      proxy: {
        // Browser -> http://localhost:5173/api/* -> NestJS. Same origin for the
        // browser, so session cookies can be SameSite=Strict with no backend CORS.
        '/api': {
          target: apiTarget,
          changeOrigin: false,
          // Append the real client address to X-Forwarded-For. The backend trusts
          // exactly this one loopback hop (see backend/src/app.setup.ts).
          xfwd: true,
        },
      },
    },
  }
})
