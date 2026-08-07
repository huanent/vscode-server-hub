import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SshTerminalApp } from '../features/sshTerminal/SshTerminalApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><SshTerminalApp /></StrictMode>);