import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MysqlOverviewApp } from '../features/mysql/overview/MysqlOverviewApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><MysqlOverviewApp /></StrictMode>);