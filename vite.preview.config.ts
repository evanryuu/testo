import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  root: fileURLToPath(new URL('./src/official-preview', import.meta.url)),
  base: './',
  // The upstream preview build also enables Node polyfills for the SDK's
  // browser dependency graph. This iframe still has no Electron/Node access.
  plugins: [nodePolyfills({ include: ['buffer', 'process'] })],
  resolve: {
    alias: {
      '@midscene/visualizer': fileURLToPath(new URL('./vendor/midscene-preview/visualizer/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-preview', import.meta.url)),
    emptyOutDir: true,
  },
});
