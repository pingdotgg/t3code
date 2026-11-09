import { t3PluginWeb } from "@t3tools/plugin-sdk/vite";
import { defineConfig } from "vite-plus";

// Builds dist/web.js. `vp run build:examples` in packages/plugin-sdk builds every example.
export default defineConfig({ root: import.meta.dirname, plugins: [t3PluginWeb()] });
