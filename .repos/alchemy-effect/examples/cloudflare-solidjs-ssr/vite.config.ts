import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solidPlugin({ ssr: true })],
  environments: {
    ssr: {
      build: {
        emptyOutDir: false,
        rolldownOptions: {
          input: resolve(__dirname, "src/entry-server.tsx"),
        },
      },
    },
  },
});
