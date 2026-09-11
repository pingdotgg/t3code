// Alchemy loads this config natively — no adapter or deployment preset
// needed here: TanStack Start is pure Vite, and `Fly.Website.TanStackStart`
// wraps the emitted server entry as a Node HTTP server after the
// build. Keep Vite's default `dist` outDir — the integration expects it.
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
