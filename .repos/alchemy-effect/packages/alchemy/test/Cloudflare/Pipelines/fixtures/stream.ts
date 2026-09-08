import * as Cloudflare from "@/Cloudflare";

/**
 * Shared by both worker fixtures so the suite also covers one stream bound
 * to two workers. Declared in its own module to keep `effect-worker.ts` from
 * importing `stack.ts` (which imports it back).
 */
export const EventsStream = Cloudflare.Pipelines.Stream("BindingStream", {});
