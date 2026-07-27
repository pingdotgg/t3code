/// <reference types="@cloudflare/workers-types" />

import type { AsyncPlatformWorkerEnv } from "./shared.ts";

/**
 * Async (non-Effect) platform Worker handler. The dispatch namespace is bound
 * via `env: { DISPATCH }` (see `shared.ts`); `InferEnv` types `env.DISPATCH` as
 * the native `cf.DispatchNamespace`, so `env.DISPATCH.get(name)` returns a
 * `Fetcher` for the user Worker. Mirrors the Effect-native `platform-worker.ts`
 * routes so the test can drive both styles identically.
 */
export default {
  async fetch(
    request: Request,
    env: AsyncPlatformWorkerEnv,
  ): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/dispatch\/([^/]+)(\/.*)?$/);
    if (!match) {
      return new Response("async-platform-worker ok");
    }
    const [, scriptName, rest] = match;
    const userWorker = env.DISPATCH.get(scriptName);
    return userWorker.fetch(
      new Request(`https://user-worker${rest ?? "/"}`, {
        headers: { "x-custom": request.headers.get("x-custom") ?? "" },
      }),
    );
  },
};
