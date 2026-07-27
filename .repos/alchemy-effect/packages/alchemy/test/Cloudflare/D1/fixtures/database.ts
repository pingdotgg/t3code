import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * The single shared D1 database both the effect-worker and the
 * async-worker bind to. The two workers namespace their rows by a
 * `style` column so they can share one physical database without
 * stepping on each other.
 */
export const TestDatabase = Cloudflare.D1.Database("D1BindingDatabase");
