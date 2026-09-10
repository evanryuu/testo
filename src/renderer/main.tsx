import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { attachOverlayScrollbars } from './lib/scrollbars';

function GlobalScrollbars() {
  React.useLayoutEffect(() => attachOverlayScrollbars(document.body), []);
  return null;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><GlobalScrollbars /><App /></React.StrictMode>);
