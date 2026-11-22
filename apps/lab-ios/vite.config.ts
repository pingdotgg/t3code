// Conn iOS design lab: web mocks of the iOS screens (src), for fast design iteration without the
// simulator. `vp run dev` serves index.html on 127.0.0.1:5801; screen, theme, state and scale
// live in the URL (src/urlState.ts).
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("../web/src/", import.meta.url)) }],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT ?? 5801),
    strictPort: true,
  },
  build: { outDir: process.env.LAB_OUT_DIR ?? "dist", emptyOutDir: true },
});
