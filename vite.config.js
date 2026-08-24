import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3000' ,
      '/imgly-assets': 'http://localhost:3000',// Routes frontend API calls to your Express server
    }
  }
});