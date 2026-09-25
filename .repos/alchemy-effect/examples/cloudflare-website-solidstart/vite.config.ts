import { defineConfig } from "vite";

import { solidStart } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solidStart(), tailwindcss()],
});
