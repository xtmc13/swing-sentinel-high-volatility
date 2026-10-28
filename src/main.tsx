import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import App from './App.tsx'
import { TRPCProvider } from './providers/TRPCProvider'
import { Toaster } from 'sonner'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <TRPCProvider>
        <App />
        <Toaster theme="dark" position="bottom-right" />
      </TRPCProvider>
    </HashRouter>
  </StrictMode>,
)
