import { defineConfig } from 'vite';
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin';

export default defineConfig({
  worker: {
    format: 'es'
  },

  build: {
    outDir: '../monaco',
    emptyOutDir: true,
    target: 'esnext',
    minify: 'esbuild',
    cssMinify: 'esbuild',
    reportCompressedSize: false,
    rollupOptions: {
      input: 'src/index.html'
    }
  },

  optimizeDeps: {
    esbuildOptions: {
      plugins: [importMetaUrlPlugin]
    }
  },

  plugins: [
    {
      generateBundle(_, bundle) {
        for (const [fileName, asset] of Object.entries(bundle)) {
          if (!fileName.endsWith('.html')) continue;
          let sourceText = null;
          if (typeof asset?.source === 'string') {
            sourceText = asset.source;
          } else if (asset?.source instanceof Uint8Array) {
            sourceText = Buffer.from(asset.source).toString('utf8');
          }
          if (typeof sourceText !== 'string') continue;

          sourceText = sourceText.replace(
            /<meta[^>]*Content-Security-Policy[^>]*>/gi,
            ''
          );

          asset.source = sourceText;
        }
      }
    }
  ]
});