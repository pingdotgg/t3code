import type { APIRoute } from "astro";
import { render } from "astro:content";

import { getDocsCatalog } from "../../lib/docs";

export const GET: APIRoute = async () => {
  const catalog = await getDocsCatalog();
  const allDocs = [catalog.indexDoc, ...catalog.docs];

  const entries = await Promise.all(
    allDocs.map(async (doc) => {
      const { headings } = await render(doc.entry);
      return {
        title: doc.title,
        category: doc.category,
        href: doc.href,
        description: doc.description,
        headings: headings
          .filter((h) => h.depth === 2 || h.depth === 3)
          .map((h) => ({ text: h.text, slug: h.slug })),
      };
    }),
  );

  return new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
