import type { APIRoute } from "astro";

import { publicCapabilities } from "../lib/configuredCapabilities";

const paths = [
  "/",
  "/product",
  "/access",
  "/pricing",
  "/waitlist",
  "/download",
  "/privacy",
  "/terms",
];

export const GET: APIRoute = () => {
  const entries = paths
    .map((path) => `<url><loc>${new URL(path, `${publicCapabilities.canonicalUrl}/`)}</loc></url>`)
    .join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;

  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
