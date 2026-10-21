import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Go backend serves the API on 8787; in dev, Vite proxies to it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: { environment: 'node' },
} as import('vite').UserConfig)
