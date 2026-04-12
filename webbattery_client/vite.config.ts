import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000, // 前端开发服务器端口
    proxy: {
      '/api': {
        target: 'http://localhost:8080', // 指向后端服务器
        changeOrigin: true,
        secure: false
      },
      '/socket.io': {
        target: 'ws://localhost:8080', // 指向后端Socket.IO服务
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
});
