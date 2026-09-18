import { newWebSocketRpcSession } from "capnweb";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { ProviderService } from "../Provider.ts";
import type { ResourceLike } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { unwrapRpcHandlers } from "./RpcSerialization.ts";
import type { RpcProxyApi } from "./RpcServer.ts";
import {
  encodeSessionEnvironment,
  SESSION_ENV_PARAM,
} from "./RpcServerEnvironment.ts";
import type { RpcSpawnPayload } from "./RpcSpawner.ts";

export class RpcProviderProxy extends Context.Service<
  RpcProviderProxy,
  {
    /**
     * The provider for `providerName`, served by the dev sidecar. `providersUrl`
     * is the URL of the module whose default export is the provider group's
     * layer (see `Local/Sidecar.ts`); the sidecar imports it on first use.
     */
    readonly get: <R extends ResourceLike>(
      providersUrl: string,
      providerName: R["Type"],
    ) => Effect.Effect<ProviderService<R>, never, AlchemyContext | Stack>;
  }
>()("alchemy/Local/RpcProviderProxy") {}

export const SPAWNER_URL_ENV_KEY = "ALCHEMY_RPC_SPAWNER_URL" as const;

/**
 * The one sidecar entry every RPC-backed provider is served from.
 * Resolve through package exports so this also works when the proxy is
 * bundled into `bin/exec.js`. The active export conditions select `src/`
 * under Bun or the dev loader and `lib/` in a published Node install.
 */
export const SIDECAR_ENTRY_URL = import.meta.resolve("alchemy/Local/Sidecar");

const make = Effect.fn(function* (spawnerUrl: string) {
  const client = yield* HttpClient.HttpClient;

  const getSession = Effect.fn(
    function* (sessionEnv: string) {
      const payload: RpcSpawnPayload = { serverEntryUrl: SIDECAR_ENTRY_URL };
      const response = yield* client.post(spawnerUrl, {
        body: yield* HttpBody.json(payload),
      });
      // The spawner returns the one shared sidecar; the stack-specific
      // environment rides the session websocket so the child can build (and
      // memoize) a provider context per stack and provider group.
      const body = yield* response.text;
      if (response.status !== 200) {
        return yield* Effect.fail(
          new Error(
            `RPC spawner POST ${spawnerUrl} returned ${response.status}: ${body.slice(0, 300)}`,
          ),
        );
      }
      let websocketUrl: URL;
      try {
        websocketUrl = new URL(body);
      } catch {
        return yield* Effect.fail(
          new Error(
            `RPC spawner POST ${spawnerUrl} did not return a websocket URL (got ${JSON.stringify(body.slice(0, 200))})`,
          ),
        );
      }
      if (websocketUrl.protocol !== "ws:" && websocketUrl.protocol !== "wss:") {
        return yield* Effect.fail(
          new Error(
            `RPC spawner POST ${spawnerUrl} returned a non-websocket URL: ${websocketUrl.toString()}`,
          ),
        );
      }
      websocketUrl.searchParams.set(SESSION_ENV_PARAM, sessionEnv);
      return newWebSocketRpcSession<RpcProxyApi>(websocketUrl.toString());
    },
    (effect) =>
      Effect.catch(effect, (error) =>
        Effect.die(
          new Error(
            "Failed to create a provider RPC session with the sidecar",
            {
              cause: error,
            },
          ),
        ),
      ),
  );

  // A websocket that drops (sidecar crash/restart, abnormal 1006 close)
  // permanently breaks the capnweb session, and a cached broken session would
  // poison every subsequent call — including test-runner retries.
  // `onRpcBroken` fires on disconnect and evicts the entry, so the next `get`
  // re-registers with the spawner (which respawns the sidecar child if it
  // died). Assigned after the cache exists; the callback only fires on live
  // sessions, which the cache must already contain.
  let evictBrokenSession: (key: string) => void = () => {};
  // One session per stack environment, shared by every provider group.
  const cache = yield* Cache.make({
    lookup: (sessionEnv: string) =>
      getSession(sessionEnv).pipe(
        Effect.tap((session) =>
          Effect.sync(() =>
            session.onRpcBroken(() => evictBrokenSession(sessionEnv)),
          ),
        ),
      ),
    capacity: Infinity,
  });
  evictBrokenSession = (key) => Effect.runFork(Cache.invalidate(cache, key));

  return RpcProviderProxy.of({
    get: Effect.fn(function* (providersUrl, providerName) {
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const key = encodeSessionEnvironment({
        alchemyContext,
        stack: { name: stack.name, stage: stack.stage },
      });
      const fetchProvider = Effect.gen(function* () {
        const session = yield* Cache.get(cache, key);
        return yield* Effect.tryPromise(
          () =>
            session.getProvider(providerName, providersUrl) as ReturnType<
              RpcProxyApi["getProvider"]
            >,
        );
      });
      // One in-place reconnect: if the session broke mid-call (the broken
      // callback may not have evicted it yet), drop it and re-register once
      // before giving up.
      const provider = yield* fetchProvider.pipe(
        Effect.catch(() =>
          Cache.invalidate(cache, key).pipe(Effect.andThen(fetchProvider)),
        ),
        Effect.orDie,
      );
      // The served shape omits the process-local `mode`/`modes` variant
      // machinery (see RpcProviderService); the unwrapped stub is a plain
      // (mode-agnostic) ProviderService.
      return unwrapRpcHandlers(provider, ["tail"]) as ProviderService<any>;
    }),
  });
});

export const layer = (url: string) => Layer.effect(RpcProviderProxy, make(url));

export const fromEnv = () =>
  Layer.effect(
    RpcProviderProxy,
    Config.String(SPAWNER_URL_ENV_KEY).pipe(Effect.flatMap(make)),
  );
