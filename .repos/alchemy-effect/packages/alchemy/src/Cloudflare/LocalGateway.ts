/**
 * Shared scaffolding for the local-simulator gateways.
 *
 * The local binding simulators (KV, R2, D1, ...) live inside workerd — only
 * a Worker with the native binding can reach them. Deploy-time code (Action
 * capability clients, provider reconciles) runs in Node, so the `*Local`
 * layers bridge the two with the runtime's platform proxy
 * (`PlatformProxy.open` — our `getPlatformProxy`): a scoped workerd
 * instance hosts the binding, and Node drives it through proxied clients.
 *
 * NOT exported from `index.ts` — provider/capability-internal scaffolding.
 */
import { layerRuntime } from "@alchemy.run/cloudflare-runtime/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AlchemyContext } from "../AlchemyContext.ts";
import { CloudflareEnvironment } from "./CloudflareEnvironment.ts";
import { isLocalId } from "./LocalRuntime.ts";

/**
 * A standalone local-runtime layer for gateway consumers OUTSIDE the
 * provider stack (e.g. capability `*Local` layers running in an Action,
 * whose ambient context has no workerd `Runtime`). Configured identically
 * to the providers' shared runtime — same `.alchemy/local` storage
 * directory — so it reads and writes the same simulator data.
 */
export const localGatewayRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const getEnv = yield* CloudflareEnvironment;
    const { dotAlchemy } = yield* AlchemyContext;
    const path = yield* Path.Path;
    return layerRuntime({
      api: {
        accountId: getEnv.pipe(Effect.map((env) => env.accountId)),
      },
      storage: {
        directory: path.join(dotAlchemy, "local"),
      },
    });
  }),
);

/** Sanitize an id into a workerd instance-name-safe suffix. */
export const gatewayName = (prefix: string, id: string) =>
  `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * Build a client whose every member resolves the resource id first and then
 * delegates: `dev:` ids to the (memoized) native-over-gateway client, real
 * ids to the HTTP client. Function members dispatch per call; Effect-valued
 * members (`raw`) dispatch on evaluation. Used by the `*Local` capability
 * scaffolding (KV, R2) where the id is a deferred accessor resolved at
 * apply time.
 */
export const dispatchByMode = <Client extends object>(
  resourceId: Effect.Effect<string>,
  httpClient: Client,
  makeNative: (id: string) => Client,
): Client => {
  let native: Client | undefined;
  let nativeId: string | undefined;
  const nativeFor = (id: string): Client => {
    if (nativeId !== id) {
      nativeId = id;
      native = makeNative(id);
    }
    return native!;
  };
  const pick = (id: string): Client =>
    isLocalId(id) ? nativeFor(id) : httpClient;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(httpClient)) {
    out[key] =
      typeof value === "function"
        ? (...args: unknown[]) =>
            Effect.flatMap(resourceId, (id) =>
              (pick(id) as Record<string, any>)[key](...args),
            )
        : Effect.flatMap(
            resourceId,
            (id) => (pick(id) as Record<string, any>)[key],
          );
  }
  return out as Client;
};
