import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// VITE_SNAPSHOT=1 builds one self-contained HTML file with captured API responses inlined,
// for the hosted demo. The normal build is served by the API from the same origin.
const snapshot = process.env.VITE_SNAPSHOT === '1';

export default defineConfig({
  plugins: [react(), ...(snapshot ? [viteSingleFile()] : [])],
  server: { proxy: { '/v1': 'http://localhost:8080' } },
  build: { sourcemap: !snapshot },
});
