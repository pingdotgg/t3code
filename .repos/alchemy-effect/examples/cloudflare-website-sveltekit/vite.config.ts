import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Alchemy loads this config natively at deploy time and injects its
// wrangler-free Cloudflare adapter into the `sveltekit()` instance below —
// do NOT declare an adapter here.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
