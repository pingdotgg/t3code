// Alchemy loads this config natively — no adapter or deployment preset
// needed here: TanStack Start is pure Vite, and `Hetzner.Website.TanStackStart`
// hosts the Node server entry as a systemd unit on port 3000. Keep Vite's
// default `dist` outDir — the integration expects it.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
