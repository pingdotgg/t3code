import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
  ],
  server: {
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
