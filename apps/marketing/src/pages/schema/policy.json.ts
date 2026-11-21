import type { APIRoute } from "astro";

import { buildManagedPolicyJsonSchema } from "@t3tools/shared/managedPolicySchema";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildManagedPolicyJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
