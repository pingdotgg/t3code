import type { APIRoute } from "astro";

import { getDocsCatalog } from "../../lib/docs";

export const GET: APIRoute = async () => {
  const catalog = await getDocsCatalog();
  return new Response(catalog.indexDoc.entry.body ?? "", {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
