import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

// A fork serving this site under its own domain names that copy, not T3's.
export const GET: APIRoute = ({ site, url }) =>
  new Response(
    `${JSON.stringify(buildT3ProjectFileJsonSchema(new URL(url.pathname, site ?? url).href), null, 2)}\n`,
    { headers: { "Content-Type": "application/json" } },
  );
