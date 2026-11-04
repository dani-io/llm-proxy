import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In production the panel is served by llm-proxy itself (admin.py) on
// ADMIN_PORT, same origin as /api. In dev, Vite proxies /api there.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const admin = env.ADMIN_UPSTREAM || 'http://192.168.10.246:8002'
  return {
    plugins: [react(), tailwindcss()],
    server: { host: true, port: 5174, proxy: { '/api': { target: admin, changeOrigin: true } } },
  }
})
