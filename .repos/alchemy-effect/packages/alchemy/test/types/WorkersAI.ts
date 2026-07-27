import * as Cloudflare from "@/Cloudflare";

// ── Cloudflare.Workers.AI barrel-shape guards ──────────────────────────────
//
// `Cloudflare/index.ts` hoists `Workers/index.ts` flatly (`export * from`)
// while also exporting the AI Gateway namespace explicitly
// (`export * as AI from "./AI/index.ts"`). Per ES module semantics the
// explicit export wins, so `Cloudflare.AI` must stay the namespace and the
// Workers AI binding must only be reachable as `Cloudflare.Workers.AI`.
// These assertions pin that shape at the type level.

// The binding is callable via the Workers namespace.
export const _binding = Cloudflare.Workers.AI("AI");

// `Cloudflare.AI` is the AI Gateway namespace, not the Workers AI binding.
export const _gateway: typeof Cloudflare.AI.Gateway = Cloudflare.AI.Gateway;

// @ts-expect-error — Cloudflare.AI is a namespace, not callable.
export const _notCallable = Cloudflare.AI("AI");
