import type { APIRoute } from "astro";

import { absoluteUrl, STATIC_PAGES } from "../lib/seo";

export const GET: APIRoute = () => {
  const urls = STATIC_PAGES.map(
    (page) =>
      `  <url><loc>${absoluteUrl(page.path)}</loc><priority>${page.priority}</priority></url>`,
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
