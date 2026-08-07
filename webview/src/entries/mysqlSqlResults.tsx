import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MysqlSqlResultsApp } from '../features/mysql/sqlResults/MysqlSqlResultsApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><MysqlSqlResultsApp /></StrictMode>);