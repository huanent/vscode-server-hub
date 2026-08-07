import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ContainerEditorApp } from '../features/containerEditor/ContainerEditorApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ContainerEditorApp /></StrictMode>);