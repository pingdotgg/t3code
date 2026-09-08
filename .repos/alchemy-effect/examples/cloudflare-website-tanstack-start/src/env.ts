import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../alchemy.run.ts";

// In development mode with TanStack Start, `import { env } from "cloudflare:workers"` does not work at the top level.
// As a workaround, we use a proxy to access the env object.
export const env = new Proxy({} as WebsiteEnv, {
  get(_, prop) {
    return cf.env[prop as keyof typeof cf.env];
  },
});
