import * as cf from "cloudflare:workers";
import type { VinextEnv } from "../alchemy.run.ts";

declare global {
  interface Env extends VinextEnv {}
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    interface Env extends VinextEnv {}
  }
}

/** Bindings via `cloudflare:workers`. Not a root `*.d.ts` (gitignored). */
export const env = new Proxy({} as VinextEnv, {
  get(_, prop) {
    return cf.env[prop as keyof typeof cf.env];
  },
});
