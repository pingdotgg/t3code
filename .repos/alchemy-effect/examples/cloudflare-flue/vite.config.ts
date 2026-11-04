import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// Flue's documented Cloudflare setup, unchanged: `flue()` generates the
// Worker entry and one Durable Object class per agent, and hands them to the
// Cloudflare plugin through `flueWorkerConfig()`. Alchemy builds and serves
// the Worker in place of `@cloudflare/vite-plugin`.
export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
