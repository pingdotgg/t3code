import type { APIRoute } from "astro";

import { absoluteUrl } from "../../lib/seo";

// RFC 9116 requires an Expires date. Deriving it from the build keeps the file valid as long as
// the site deploys at least once a year.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const GET: APIRoute = () => {
  const body = [
    "Contact: mailto:security@t3.codes",
    `Policy: ${absoluteUrl("/security-policy")}`,
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "Preferred-Languages: en",
    `Expires: ${new Date(Date.now() + ONE_YEAR_MS).toISOString()}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
