import { unwrapRpcHandlers } from "alchemy/Local/RpcSerialization";
import type { RpcProxyApi } from "alchemy/Local/RpcServer";
import { encodeSessionEnvironment, SESSION_ENV_PARAM } from "alchemy/Local/RpcServerEnvironment";
import { layerServer, RpcSpawner } from "alchemy/Local/RpcSpawner";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import { newWebSocketRpcSession } from "capnweb";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* Effect.sync(
    () =>
      JSON.parse(process.env.COMMAND_FIXTURES!) as {
        home: string;
        ready: string;
        commands: Array<{ command: string; env: Record<string, string> }>;
      },
  );
  const spawner = yield* RpcSpawner;
  const http = yield* HttpClient.HttpClient;
  const wsUrl = yield* http
    .post(spawner.url, {
      body: yield* HttpBody.json({
        serverEntryUrl: new URL("../../../src/Local/Sidecar.ts", import.meta.url).href,
      }),
    })
    .pipe(Effect.flatMap((response) => response.text));
  const url = new URL(wsUrl);
  url.searchParams.set(
    SESSION_ENV_PARAM,
    encodeSessionEnvironment({
      alchemyContext: {
        dotAlchemy: input.home,
        updateStateStore: false,
        dev: true,
        adopt: false,
      },
      stack: { name: "CommandShutdown", stage: "test" },
    }),
  );
  const session = yield* Effect.sync(() => newWebSocketRpcSession<RpcProxyApi>(url.toString()));
  const wrapped = yield* Effect.promise(
    () =>
      session.getProvider(
        "Command.Dev",
        new URL("../../../src/Command/Local.ts", import.meta.url).href,
      ) as ReturnType<RpcProxyApi["getProvider"]>,
  );
  const provider = unwrapRpcHandlers(wrapped, []);
  yield* Effect.forEach(
    input.commands,
    (news, index) =>
      provider.reconcile({
        id: `Command${index}`,
        fqn: `Command${index}`,
        instanceId: `Command${index}`,
        news,
        olds: undefined,
        output: undefined,
        session: {} as never,
        bindings: [],
      }),
    { concurrency: "unbounded" },
  );
  yield* fs.writeFileString(input.ready, "ready");
  yield* Effect.never;
});
program.pipe(
  Effect.provide(
    Layer.mergeAll(
      layerServer({ profile: undefined, envFile: undefined }).pipe(Layer.provide(PlatformServices)),
      PlatformServices,
      FetchHttpClient.layer,
    ),
  ),
  Effect.scoped,
  runMain,
);
