import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "Alchemy with Vocs",
  description: "A Vocs documentation site deployed to Cloudflare Workers",
  sidebar: [
    { text: "Home", link: "/" },
    { text: "Guide", link: "/guide" },
    { text: "Counter", link: "/counter" },
  ],
});
