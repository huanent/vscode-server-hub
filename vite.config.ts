import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	root: 'webview',
	base: './',
	plugins: [react(), tailwindcss()],
	build: {
		outDir: '../media',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				containerEditor: 'webview/src/entries/containerEditor.tsx',
				mysqlOverview: 'webview/src/entries/mysqlOverview.tsx',
				mysqlSqlResults: 'webview/src/entries/mysqlSqlResults.tsx',
				mysqlTablePreview: 'webview/src/entries/mysqlTablePreview.tsx',
				serverForm: 'webview/src/entries/serverForm.tsx',
				sshTerminal: 'webview/src/entries/sshTerminal.tsx',
			},
			output: {
				entryFileNames: '[name].js',
				assetFileNames: assetInfo => assetInfo.names?.some(name => name.endsWith('.css'))
					? '[name][extname]'
					: 'assets/[name]-[hash][extname]',
			},
		},
		cssCodeSplit: true,
	},
});