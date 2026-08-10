import type { APIRoute } from "astro";

import { publicCapabilities } from "../lib/configuredCapabilities";

export const GET: APIRoute = () => {
  const body = publicCapabilities.legal.publicationReady
    ? `User-agent: *\nAllow: /\nSitemap: ${publicCapabilities.canonicalUrl}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
