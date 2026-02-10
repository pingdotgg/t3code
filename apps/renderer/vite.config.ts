import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  define: {
    // In dev mode, tell the renderer where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(
      process.env.VITE_WS_URL ?? "",
    ),
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
