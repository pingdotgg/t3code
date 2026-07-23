import { newWebSocketRpcSession, type RpcStub } from "capnweb";
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

const make = Effect.fnUntraced(function* (spawnerUrl: string) {
  const client = yield* HttpClient.HttpClient;

  const getSession = Effect.fnUntraced(
    function* (serverEntryUrl: string) {
      const alchemyContext = yield* AlchemyContext;
      const stack = yield* Stack;
      const payload: RpcSpawnPayload = {
        serverEntryUrl,
        alchemyContext,
        stack: { name: stack.name, stage: stack.stage },
      };
      const response = yield* client.post(spawnerUrl, {
        body: yield* HttpBody.json(payload),
      });
      const websocketUrl = yield* response.text;
      return newWebSocketRpcSession(websocketUrl) as RpcStub<RpcProxyApi>;
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

  const cache = yield* Cache.make({
    lookup: getSession,
    capacity: Infinity,
    requireServicesAt: "lookup",
  });

  return RpcProviderProxy.of({
    get: Effect.fnUntraced(function* (mainUrl, providerName) {
      const session = yield* cache.lookup(mainUrl);
      const provider = yield* Effect.promise(
        () =>
          session.getProvider(providerName) as ReturnType<
            RpcProxyApi["getProvider"]
          >,
      );
      return unwrapRpcHandlers(provider, ["tail"]);
    }),
  });
});

export const layer = (url: string) => Layer.effect(RpcProviderProxy, make(url));

export const fromEnv = () =>
  Layer.effect(
    RpcProviderProxy,
    Config.string(SPAWNER_URL_ENV_KEY).pipe(Effect.flatMap(make)),
  );
