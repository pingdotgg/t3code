import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// The playground's HTTPS variant: the dev server serves over TLS.
export default defineConfig({
  plugins: [basicSsl()],
});
