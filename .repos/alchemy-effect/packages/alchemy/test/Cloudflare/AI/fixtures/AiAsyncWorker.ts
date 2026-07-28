import * as Cloudflare from "@/Cloudflare";
import * as pathe from "pathe";

/**
 * Async (non-Effect) Worker declaring the Workers AI binding via
 * `env: { AI: Cloudflare.Workers.AI() }`. `InferEnv` maps the marker to the
 * native `Ai` runtime handle, so the handler calls `env.AI.run(...)`
 * directly.
 */
export const AiAsyncWorker = Cloudflare.Worker("AiAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "AiAsyncHandler.ts"),
  env: {
    AI: Cloudflare.Workers.AI(),
  },
});

export type AiAsyncWorkerEnv = Cloudflare.InferEnv<typeof AiAsyncWorker>;
