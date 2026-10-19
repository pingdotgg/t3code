import * as NodeServices from "@effect/platform-node/NodeServices";
import { AbsolutePath, Location } from "@opencode/client/effect";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Filter from "effect/Filter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe } from "vite-plus/test";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "../OpenCodeServerLedger.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

const binaryPath = process.env.OPENCODE2_BIN;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopByPid = (pid: number) =>
  Effect.gen(function* () {
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(pid, name);
      } catch {}
    };
    signal("SIGTERM");
    for (let attempt = 0; attempt < 50 && isAlive(pid); attempt++) {
      yield* Effect.sleep("100 millis");
    }
    if (isAlive(pid)) signal("SIGKILL");
  });

const startExternalServer = Effect.fn("OpenCode2ServerLive.startExternalServer")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(binaryPath!, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: input.directory,
      env: input.environment,
    }),
  );
  const pid = Number(child.pid);
  yield* Effect.addFinalizer(() => stopByPid(pid));
  const url = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap(
      Filter.fromPredicateOption((line: string) =>
        Option.fromUndefinedOr(/server listening on\s+(https?:\/\/\S+)/i.exec(line)?.[1]),
      ),
    ),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("30 seconds"),
  );
  return { url, pid };
});

describe.runIf(binaryPath !== undefined)("OpenCode2Server live", () => {
  it.live(
    "spawns one authenticated server per instance and stops it by PID",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode2-server-live-" });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.makeDirectory(first);
        yield* fs.makeDirectory(second);
        const environment = {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          OPENCODE_SERVER_PASSWORD: "ambient-password",
        };

        const instanceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const server = Context.get(
          yield* Layer.buildWithScope(
            OpenCode2Server.layer({
              binaryPath: binaryPath!,
              serverUrl: "",
              serverPassword: "",
              directory: first,
              environment,
            }),
            instanceScope,
          ),
          OpenCode2Server.OpenCode2Server,
        );

        const spawned = yield* server.withConnection((connection) =>
          Effect.gen(function* () {
            const info = yield* connection.client.server.info();
            const session = yield* connection.client.session.create({
              title: "first location",
              location: Location.PublicRef.make({ directory: AbsolutePath.make(first) }),
            });
            return { ...connection, pid: info.pid, session };
          }),
        );
        assert.strictEqual(spawned.version, "2.0.18");
        assert.isFalse(spawned.external);
        assert.isTrue(isAlive(spawned.pid));

        const secondLocation = yield* server.withConnection((connection) =>
          Effect.gen(function* () {
            const info = yield* connection.client.server.info();
            const session = yield* connection.client.session.create({
              title: "second location",
              location: Location.PublicRef.make({ directory: AbsolutePath.make(second) }),
            });
            return { url: connection.url, pid: info.pid, session };
          }),
        );
        assert.strictEqual(secondLocation.url, spawned.url);
        assert.strictEqual(secondLocation.pid, spawned.pid);
        assert.strictEqual(secondLocation.session.location.directory, second);
        assert.strictEqual(spawned.session.location.directory, first);

        const external = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: spawned.url,
          serverPassword: "wrong-password",
          directory: first,
          environment,
        });
        const rejected = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(rejected.detail, "rejected the server password");
        const ambient = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: spawned.url,
          serverPassword: environment.OPENCODE_SERVER_PASSWORD,
          directory: first,
          environment,
        });
        const ambientRejected = yield* ambient.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(ambientRejected.detail, "rejected the server password");

        const utf8Password = "pässwörd€";
        const externalServer = yield* startExternalServer({
          environment: OpenCode2Server.serverEnvironment(environment, Redacted.make(utf8Password)),
          directory: second,
        });
        const utf8 = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: externalServer.url,
          serverPassword: utf8Password,
          directory: second,
          environment,
        });
        const utf8Connection = yield* utf8.withConnection((connection) =>
          Effect.succeed(connection),
        );
        assert.strictEqual(utf8Connection.version, "2.0.18");
        assert.isTrue(utf8Connection.external);
        const asciiOnly = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: externalServer.url,
          serverPassword: "passwrd",
          directory: second,
          environment,
        });
        const asciiRejected = yield* asciiOnly.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(asciiRejected.detail, "rejected the server password");

        yield* Scope.close(instanceScope, Exit.void);
        for (let attempt = 0; attempt < 50 && isAlive(-spawned.pid); attempt++) {
          yield* Effect.sleep("100 millis");
        }
        assert.isFalse(isAlive(spawned.pid), `opencode serve ${spawned.pid} outlived its instance`);
        assert.isFalse(isAlive(-spawned.pid), `a process in group ${spawned.pid} outlived it`);
        const unreachable = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(unreachable.detail, "Could not reach the OpenCode server");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            OpenCode2Client.layer,
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
        ),
      ),
    60_000,
  );
});
