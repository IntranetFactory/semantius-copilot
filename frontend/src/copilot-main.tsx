import { createRoot } from 'react-dom/client';
import { CopilotApp } from './CopilotApp.tsx';
import './index.css'; // Tailwind v4 + shadcn theme (layered) — must precede style.css
import './style.css'; // legacy app CSS (unlayered, so it keeps winning over preflight)

createRoot(document.getElementById('root')!).render(<CopilotApp />);
