/**
 * Node-side path into the local workerd KV simulator, built on the
 * runtime's platform proxy (`PlatformProxy.open` — our `getPlatformProxy`).
 *
 * For a `dev:` namespace there is no cloud namespace to speak REST to.
 * Instead, each operation opens a scoped platform proxy hosting the native
 * KV binding and runs against `proxy.env.KV` — the same
 * `runtime.KVNamespace` surface the Worker-binding client builders
 * (`makeReadKVClient` / `makeWriteKVClient`) already consume, so the
 * `*Local` layers reuse those builders verbatim:
 *
 *   Node ── proxy.env.KV.get(...) ──▶ kv service ──▶ KVNamespaceObject
 *
 * One proxy boot per operation — slow but correct; the `*Local` layers run
 * in deploy-time Actions, not on a request path. Data lands in the same
 * `{storage}/kv` directory every local worker binding reads.
 *
 * NOT exported from `index.ts` — capability-internal scaffolding.
 */
import { KvNamespace } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { open } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import type * as runtime from "@cloudflare/workers-types";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { gatewayName, localGatewayRuntime } from "../LocalGateway.ts";
import type { makeKVNamespaceHelpers } from "./NamespaceBinding.ts";
import { NamespaceError } from "./NamespaceTypes.ts";

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, NamespaceError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new NamespaceError({
        message: error?.message ?? "Unknown error",
        cause: error,
      }),
  });

/**
 * Binding-client helpers backed by a per-operation platform proxy instead
 * of a Worker's `env`. `raw` cannot be satisfied — a native namespace only
 * lives as long as its proxy's scope — so it dies with guidance.
 */
export const makeProxyKVNamespaceHelpers = (
  namespaceId: string,
  /**
   * The FULL ambient stack-eval context: platform services for booting
   * workerd plus `CloudflareEnvironment`/`AlchemyContext` for the runtime
   * layer.
   */
  ambient: Context.Context<never>,
): ReturnType<typeof makeKVNamespaceHelpers> => {
  const use = <T>(
    fn: (raw: runtime.KVNamespace<string>) => Promise<T>,
  ): Effect.Effect<T, NamespaceError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const proxy = yield* open({
          name: gatewayName("alchemy-kv-gateway", namespaceId),
          bindings: [KvNamespace.local({ binding: "KV", id: namespaceId })],
        });
        const kv = (proxy.env as Record<string, unknown>)
          .KV as runtime.KVNamespace<string>;
        return yield* tryPromise(() => fn(kv));
      }),
    ).pipe(
      Effect.provide(localGatewayRuntime),
      // The gateway layer's platform requirements are satisfied by the
      // ambient stack-eval context; `Context<never>` can't prove that
      // statically, so erase the leftover R (and the proxy's own infra
      // error channel) with a cast — mirroring D1's gateway.
      Effect.provideContext(ambient),
    ) as Effect.Effect<T, NamespaceError>;

  const raw = Effect.die(
    new NamespaceError({
      message:
        "A locally-emulated KV namespace has no long-lived native binding outside a Worker; use get/put/delete/list/getWithMetadata (each runs through a scoped local gateway).",
      cause: new Error("unsupported"),
    }),
  ) as Effect.Effect<runtime.KVNamespace<string>>;

  return { raw, use, tryPromise };
};
