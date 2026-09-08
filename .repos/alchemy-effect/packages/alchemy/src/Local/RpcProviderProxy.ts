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
    readonly get: <R extends ResourceLike>(
      serverEntryUrl: string,
      providerName: R["Type"],
    ) => Effect.Effect<ProviderService<R>, never, AlchemyContext | Stack>;
  }
>()("alchemy/Local/RpcProviderProxy") {}

export const SPAWNER_URL_ENV_KEY = "ALCHEMY_RPC_SPAWNER_URL" as const;

/**
 * Separator for the session-cache key. `\u0000` cannot appear in either half:
 * JSON.stringify escapes control characters and URLs cannot carry raw NULs.
 */
const SESSION_KEY_SEPARATOR = "\u0000";

const make = Effect.fn(function* (spawnerUrl: string) {
  const client = yield* HttpClient.HttpClient;

  const getSession = Effect.fn(
    function* (serverEntryUrl: string, sessionEnv: string) {
      const payload: RpcSpawnPayload = { serverEntryUrl };
      const response = yield* client.post(spawnerUrl, {
        body: yield* HttpBody.json(payload),
      });
      // The spawner returns one shared child per entry URL; the stack-specific
      // environment rides the session websocket so the child can build (and
      // memoize) a provider context per stack.
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
    (effect, serverEntryUrl) =>
      Effect.catch(effect, (error) =>
        Effect.die(
          new Error(
            `Failed to create provider RPC session for "${serverEntryUrl}"`,
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
  const cache = yield* Cache.make({
    lookup: (key: string) => {
      const separator = key.indexOf(SESSION_KEY_SEPARATOR);
      return getSession(key.slice(0, separator), key.slice(separator + 1)).pipe(
        Effect.tap((session) =>
          Effect.sync(() => session.onRpcBroken(() => evictBrokenSession(key))),
        ),
      );
    },
    capacity: Infinity,
  });
  evictBrokenSession = (key) => Effect.runFork(Cache.invalidate(cache, key));

  return RpcProviderProxy.of({
    get: Effect.fn(function* (mainUrl, providerName) {
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const sessionEnv = encodeSessionEnvironment({
        alchemyContext,
        stack: { name: stack.name, stage: stack.stage },
      });
      const key = mainUrl + SESSION_KEY_SEPARATOR + sessionEnv;
      const fetchProvider = Effect.gen(function* () {
        const session = yield* Cache.get(cache, key);
        return yield* Effect.tryPromise(
          () =>
            session.getProvider(providerName) as ReturnType<
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
    Config.string(SPAWNER_URL_ENV_KEY).pipe(Effect.flatMap(make)),
  );
