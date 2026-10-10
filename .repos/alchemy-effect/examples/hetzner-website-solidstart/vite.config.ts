import { solidStart } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Alchemy loads this config natively — no adapter and NO `nitroV2Plugin()`
// here: `Hetzner.Website.SolidStart` appends its own nitro plugin instance
// carrying the `node` preset.
export default defineConfig({
  plugins: [solidStart(), tailwindcss()],
});
