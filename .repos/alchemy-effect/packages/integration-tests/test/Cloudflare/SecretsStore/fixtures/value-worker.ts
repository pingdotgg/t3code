import type * as runtime from "@cloudflare/workers-types";

// Async (non-Effect) Worker that echoes the value of the Secrets Store
// secret bound as `MY_SECRET`, so a test can read a secret value back after
// an update (the Secrets Store API never returns values).
export default {
  fetch: async (_request: Request, env: { MY_SECRET: runtime.SecretsStoreSecret }) =>
    Response.json({ value: await env.MY_SECRET.get() }),
};
