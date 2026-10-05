import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext({ prerender: true }), tailwindcss()],
});
