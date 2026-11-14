import type { APIRoute } from "astro";

import {
  DEFAULT_LOCALE,
  isLocalizedPath,
  LOCALES,
  type LocalizedPath,
  localizedHref,
} from "../i18n/locales";
import { absoluteUrl, STATIC_PAGES } from "../lib/seo";

// Each localized URL lists every translation plus x-default, as Google's sitemap hreflang format asks.
const alternateLinks = (path: LocalizedPath) =>
  [
    ...LOCALES.map((entry) => ({ hreflang: entry.code, href: localizedHref(entry.code, path) })),
    { hreflang: "x-default", href: localizedHref(DEFAULT_LOCALE, path) },
  ]
    .map(
      (entry) =>
        `    <xhtml:link rel="alternate" hreflang="${entry.hreflang}" href="${absoluteUrl(entry.href)}"/>`,
    )
    .join("\n");

export const GET: APIRoute = () => {
  const urls = STATIC_PAGES.flatMap((page) => {
    const path = page.path;
    if (!isLocalizedPath(path)) {
      return [`  <url><loc>${absoluteUrl(path)}</loc><priority>${page.priority}</priority></url>`];
    }
    const alternates = alternateLinks(path);
    return LOCALES.map(
      (entry) =>
        `  <url>\n    <loc>${absoluteUrl(localizedHref(entry.code, path))}</loc>\n    <priority>${page.priority}</priority>\n${alternates}\n  </url>`,
    );
  });
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
