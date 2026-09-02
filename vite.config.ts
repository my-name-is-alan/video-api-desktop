import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: resolve(process.cwd(), 'index.html'),
    },
  },
  server: {
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
