import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import '../styles/extension.css';

const root = document.getElementById('root');
if (!root) throw new Error('Options root is missing');
createRoot(root).render(<StrictMode><Options /></StrictMode>);
