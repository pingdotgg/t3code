// Mirrors `@cloudflare/vite-plugin`'s `playground/main-resolution`.
import { text } from "./another/another";

export default {
  async fetch() {
    return Response.json({ entry: "Root config", imported: text });
  },
};
