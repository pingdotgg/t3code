import { octane } from "@octanejs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  plugins: [
    octane(),
    tailwindcss(),
    {
      name: "native-app-plugin",
      transformIndexHtml(html) {
        return html.replace("NATIVE_HTML", "native-plugin-preserved");
      },
    },
  ],
  build: { target: "esnext" },
});
