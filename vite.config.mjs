import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: 'resources/webview',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				'server-form': resolve('webviews/server-form/index.html'),
			},
			output: {
				entryFileNames: '[name].js',
				assetFileNames: '[name][extname]',
			},
		},
	},
});