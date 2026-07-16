import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { MeetingProvider } from './context/MeetingContext'
import { ThemeProvider } from './context/ThemeContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <MeetingProvider>
        <App />
      </MeetingProvider>
    </ThemeProvider>
  </React.StrictMode>,
)