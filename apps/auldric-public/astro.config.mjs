import { defineConfig } from "astro/config";

function configuredSite(value) {
  if (!value) return "https://auldric.com";

  try {
    const url = new URL(value);
    const auldricHost = url.hostname === "auldric.com" || url.hostname.endsWith(".auldric.com");
    return url.protocol === "https:" && auldricHost ? url.origin : "https://auldric.com";
  } catch {
    return "https://auldric.com";
  }
}

export default defineConfig({
  output: "static",
  site: configuredSite(process.env.PUBLIC_AULDRIC_SITE_URL),
  server: {
    port: Number(process.env.PORT ?? 4321),
  },
});
