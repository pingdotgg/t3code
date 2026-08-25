// Test fixture: boots an RpcSpawner, starts the Command.Dev RPC sidecar,
// reconciles a real DevServer through that sidecar, prints the dev-server pid,
// then idles until the test harness kills this parent process.
// Relative imports (not `@/` alias) so this file runs under both Bun and Node
// without a paths-aware loader.
import { newWebSocketRpcSession } from "capnweb";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { unwrapRpcHandlers } from "../../../src/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "../../../src/Local/RpcServer.ts";
import { layerServer, RpcSpawner } from "../../../src/Local/RpcSpawner.ts";
import { PlatformServices } from "../../../src/Util/PlatformServices.ts";

const sidecarEntry = process.argv[2];
const command = process.argv[3];
const pidFile = process.argv[4];

if (!sidecarEntry || !command || !pidFile) {
  console.error(
    "usage: rpc-spawner-devserver-parent.ts <sidecar-entry-url> <command> <pid-file>",
  );
  process.exit(2);
}

const program = Effect.gen(function* () {
  const sp = yield* RpcSpawner;
  const http = yield* HttpClient.HttpClient;
  const wsUrl = yield* http
    .post(sp.url, {
      body: yield* HttpBody.json({
        serverEntryUrl: sidecarEntry,
        alchemyContext: {
          dotAlchemy: "/tmp/.alchemy",
          updateStateStore: false,
          dev: true,
          adopt: false,
        },
        stack: { name: "test", stage: "dev" },
      }),
    })
    .pipe(Effect.flatMap((res) => res.text));

  const session = newWebSocketRpcSession<RpcProxyApi>(wsUrl);
  const wrapped = yield* Effect.promise(
    () =>
      session.getProvider("Command.Dev") as ReturnType<
        RpcProxyApi["getProvider"]
      >,
  );
  const provider = unwrapRpcHandlers(wrapped, []);

  yield* provider.reconcile({
    id: "Dev",
    fqn: "Dev",
    instanceId: "Dev",
    news: {
      command,
      env: { PID_FILE: pidFile, MARKER: "rpc-devserver" },
    },
    olds: undefined,
    output: undefined,
    session: {} as never,
    bindings: [],
  });

  const pid = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(pidFile);
    return (JSON.parse(content) as { pid: number }).pid;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));

  console.log(`PARENT_PID=${process.pid}\n`);
  console.log(`DEVSERVER_PID=${pid}\n`);

  const stop = yield* Deferred.make<void>();
  yield* Deferred.await(stop);
});

program
  .pipe(
    Effect.provide([
      Layer.provide(
        layerServer({ profile: undefined, envFile: undefined }),
        PlatformServices,
      ),
      PlatformServices,
      FetchHttpClient.layer,
    ]),
    Effect.scoped,
    Effect.runPromise,
  )
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
