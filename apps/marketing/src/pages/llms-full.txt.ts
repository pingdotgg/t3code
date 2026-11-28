import type { APIRoute } from "astro";

import { getDocsCatalog } from "../lib/docs";
import { absoluteUrl } from "../lib/seo";

export const GET: APIRoute = async () => {
  const catalog = await getDocsCatalog();
  const allDocs = [catalog.indexDoc, ...catalog.docs];

  const sections = allDocs.map((doc) => {
    const body = (doc.entry.body ?? "").trim();
    return `<!-- Source: ${absoluteUrl(doc.rawHref)} -->\n${body}`;
  });

  return new Response(`${sections.join("\n\n---\n\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
