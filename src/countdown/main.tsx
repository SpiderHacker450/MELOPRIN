import React from 'react';
import ReactDOM from 'react-dom/client';
import { CountdownApp } from './CountdownApp';
import '../styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CountdownApp onUnlock={() => window.location.reload()} />
  </React.StrictMode>
);

