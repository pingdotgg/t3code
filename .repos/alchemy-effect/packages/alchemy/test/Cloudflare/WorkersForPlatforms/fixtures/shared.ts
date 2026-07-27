import * as Cloudflare from "@/Cloudflare/index.ts";
import * as pathe from "pathe";

/**
 * Dispatch namespace shared by the platform Worker (which binds it via `Get`)
 * and the user Worker (which is uploaded *into* it via the Worker `namespace`
 * prop). Deterministic, constant name per the test conventions.
 */
export const DispatchNs = Cloudflare.WorkersForPlatforms.DispatchNamespace(
  "WfpBindingNs",
  { name: "alchemy-wfp-binding-test-ns" },
);

/**
 * Async (non-Effect) platform Worker that declares the dispatch namespace on
 * its `env`. `InferEnv` resolves `DISPATCH` to the native `cf.DispatchNamespace`
 * runtime binding, so the handler calls `env.DISPATCH.get(name)` directly — the
 * `env`-binding counterpart to the Effect-native `Get` platform worker.
 */
export const AsyncPlatformWorker = Cloudflare.Worker("WfpAsyncPlatformWorker", {
  main: pathe.resolve(import.meta.dirname, "async-platform-handler.ts"),
  url: true,
  env: {
    DISPATCH: DispatchNs,
  },
});

export type AsyncPlatformWorkerEnv = Cloudflare.InferEnv<
  typeof AsyncPlatformWorker
>;

/**
 * Raw ESM source for a trivial "user worker" uploaded into {@link DispatchNs}.
 * Using the `script` form keeps it a plain module (no Effect runtime), which is
 * all we need to prove dynamic dispatch forwards the request: it echoes its
 * path and the `x-custom` header back as JSON so the test can assert the
 * platform Worker reached it.
 */
export const userWorkerScript = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      handledBy: "user-worker",
      path: url.pathname,
      customHeader: request.headers.get("x-custom"),
    });
  },
};`;
