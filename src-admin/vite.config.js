import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dialog shows ../admin/digitalstrom.png, which sits next to the built index.html.
// During development the file is served from there instead of being copied here, so the
// icon does not exist twice in the repository.
const serveAdapterIcon = () => ({
    name: 'serve-adapter-icon',
    apply: 'serve',
    configureServer(server) {
        server.middlewares.use('/digitalstrom.png', (_req, res) => {
            res.setHeader('Content-Type', 'image/png');
            res.end(readFileSync(fileURLToPath(new URL('../admin/digitalstrom.png', import.meta.url))));
        });
    },
});

// The admin interface is built into ../admin, next to the icon that io-package.json
// already refers to. emptyOutDir stays off so digitalstrom.png is not deleted.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: './',
    plugins: [react(), serveAdapterIcon()],
    // MUI 6 ships modern syntax; a lower transform target would try to down-compile it
    // and fails on destructuring. Admin runs in a current browser, so es2022 is fine.
    // Vite 8 transforms with oxc and pre-bundles with rolldown, so the target is set there.
    oxc: { target: 'es2022' },
    optimizeDeps: { rolldownOptions: { transform: { target: 'es2022' } } },
    resolve: {
        dedupe: ['react', 'react-dom', '@mui/material', '@emotion/react', '@emotion/styled'],
    },
    build: {
        target: 'es2022',
        outDir: fileURLToPath(new URL('../admin', import.meta.url)),
        emptyOutDir: false,
        sourcemap: false,
        chunkSizeWarningLimit: 1400,
        rolldownOptions: {
            output: {
                entryFileNames: 'assets/index.js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name][extname]',
            },
        },
    },
    server: { port: 5200 },
});
