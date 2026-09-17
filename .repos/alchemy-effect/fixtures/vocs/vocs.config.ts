import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "Vocs Fixture",
  description: "E2E fixture: vocs on Cloudflare Workers via @alchemy.run/frontend-frameworks/waku",
  sidebar: [
    { text: "Home", link: "/" },
    { text: "Guide", link: "/guide" },
    { text: "Counter", link: "/counter" },
  ],
});
