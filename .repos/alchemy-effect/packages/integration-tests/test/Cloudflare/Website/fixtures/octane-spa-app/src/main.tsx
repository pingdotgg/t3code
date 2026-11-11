import { createRoot } from "octane";
import { App } from "./App.tsx";

// Client-only mount: no SSR, no hydration source — the app renders
// entirely in the browser into the shell's #root element.
createRoot(document.getElementById("root")!).render(<App />);
