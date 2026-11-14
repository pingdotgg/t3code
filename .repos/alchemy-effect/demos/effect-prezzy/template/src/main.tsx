import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-950 text-zinc-100">
      <div className="text-center">
        <p className="text-sm font-medium tracking-widest text-violet-400 uppercase">My App</p>
        <h1 className="mt-3 text-6xl font-semibold tracking-tight">Hello from Cloudflare</h1>
        <p className="mt-4 text-lg text-zinc-400">A Vite + React site, deployed with Alchemy.</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
