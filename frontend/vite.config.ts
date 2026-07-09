import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/kvm/',
  server: {
    proxy: { '/kvm/api': { target: 'http://localhost:8000', rewrite: (p) => p.replace(/^\/kvm/, '') } },
  },
})
