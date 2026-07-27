// Augment the workers environment with WebsiteEnv from the alchemy.run package
// so that `import { env } from "cloudflare:workers"` is correctly typed.

import type { WebsiteEnv } from "../alchemy.run.ts";

declare module "cloudflare:workers" {
  namespace Cloudflare {
    interface Env extends WebsiteEnv {}
  }
}
