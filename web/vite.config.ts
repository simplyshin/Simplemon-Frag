import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// dev 模式 /api 代理到本地 MCP 服务；build 产物由服务直接托管，同源无需代理
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://localhost:3210',
    },
  },
});
