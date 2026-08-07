import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerFormApp } from '../features/serverForm/ServerFormApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ServerFormApp />
	</StrictMode>,
);