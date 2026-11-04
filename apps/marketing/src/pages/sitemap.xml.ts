import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { absoluteUrl, STATIC_PAGES } from "../lib/seo";

const libraryPath = (id: string): string =>
  id === "index" ? "/learn" : `/learn/${id.replace(/\/index$/, "")}`;

export const GET: APIRoute = async () => {
  const library = await getCollection("library");
  const urls = [
    ...STATIC_PAGES.map(
      (page) =>
        `  <url><loc>${absoluteUrl(page.path)}</loc><priority>${page.priority}</priority></url>`,
    ),
    ...library.map(
      (entry) =>
        `  <url><loc>${absoluteUrl(libraryPath(entry.id))}</loc><lastmod>${entry.data.updated.toISOString().slice(0, 10)}</lastmod></url>`,
    ),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
