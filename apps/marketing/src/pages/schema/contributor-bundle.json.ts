import type { APIRoute } from "astro";

import { buildContributorBundleJsonSchema } from "@t3tools/shared/contributorBundle";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildContributorBundleJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
