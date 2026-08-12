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
				containerEditor: 'webview/src/features/containerEditor/main.tsx',
				mysqlOverview: 'webview/src/features/mysql/overview/main.tsx',
				mysqlSqlResults: 'webview/src/features/mysql/sqlResults/main.tsx',
				mysqlTablePreview: 'webview/src/features/mysql/tablePreview/main.tsx',
				serverForm: 'webview/src/features/serverForm/main.tsx',
				sshTerminal: 'webview/src/features/sshTerminal/main.tsx',
			},
			output: {
				entryFileNames: '[name].js',
				assetFileNames: assetInfo => {
					if (!assetInfo.names?.some(name => name.endsWith('.css'))) {
						return 'assets/[name]-[hash][extname]';
					}
					return assetInfo.names.some(name => name === 'sshTerminal.css')
						? 'sshTerminal.css'
						: 'styles.css';
				},
			},
		},
		cssCodeSplit: true,
	},
});