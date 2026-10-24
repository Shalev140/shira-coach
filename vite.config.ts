import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Generates dist/sw.js after the build: a precache list of every emitted file
 * plus a content hash as the cache version, so the whole app works offline
 * and updates atomically when a new build is deployed.
 */
function offlineServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'shira-offline-sw',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      const urls: string[] = [];
      for (const file of files.sort()) {
        const rel = relative(outDir, file).split(sep).join('/');
        if (rel === 'sw.js' || rel.endsWith('.map')) continue;
        hash.update(rel);
        hash.update(readFileSync(file));
        urls.push(rel === 'index.html' ? './' : `./${rel}`);
      }
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync('src/sw-template.js', 'utf8');
      writeFileSync(
        join(outDir, 'sw.js'),
        template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(urls, null, 0)),
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), offlineServiceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: { port: 4590, host: true },
  // the built app gets its own origin: its offline service worker must never serve the dev server's pages
  preview: { port: 4591, host: true },
  test: {
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
