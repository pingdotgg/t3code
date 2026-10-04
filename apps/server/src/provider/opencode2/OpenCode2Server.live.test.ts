/**
 * Live check of the OpenCode 2 server lifecycle against a real binary:
 *
 *   OPENCODE2_BIN=/path/to/opencode vp test run src/provider/opencode2/OpenCode2Server.live.test.ts
 *
 * No model is called. The server runs with isolated HOME and XDG directories.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import * as OpenCodeRuntime from "../opencodeRuntime.ts";
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

/**
 * Stops only a server PID captured by this isolated test.
 */
const stopByPid = (pid: number) =>
  Effect.gen(function* () {
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(pid, name);
      } catch {
        // Already exited.
      }
    };
    signal("SIGTERM");
    for (let attempt = 0; attempt < 50 && isAlive(pid); attempt++) {
      yield* Effect.sleep("100 millis");
    }
    if (isAlive(pid)) signal("SIGKILL");
  });

/**
 * Starts `opencode serve` the way a user would run it themselves. It is stopped
 * by its PID when the calling scope closes, whether or not the test passed.
 */
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
    "uses the CLI managed service and leaves it running when the T3 instance closes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode2-managed-live-" });
        const project = path.join(root, "project");
        yield* fs.makeDirectory(project);
        const environment = {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        };
        const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
        const net = yield* NetService.NetService;
        const servicePort = yield* net.reserveLoopbackPort();
        const configuredPort = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["service", "set", "port", String(servicePort)],
          cwd: project,
          environment,
        });
        assert.strictEqual(configuredPort.code, 0);
        let cliManagedPid = 0;
        yield* Effect.addFinalizer(() =>
          cliManagedPid === 0 ? Effect.void : stopByPid(cliManagedPid),
        );
        const instanceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const server = Context.get(
          yield* Layer.buildWithScope(
            OpenCode2Server.layer({
              binaryPath: binaryPath!,
              serverUrl: "",
              serverPassword: "",
              directory: project,
              environment,
            }),
            instanceScope,
          ),
          OpenCode2Server.OpenCode2Server,
        );

        const connection = yield* server.withConnection((value) =>
          Effect.gen(function* () {
            const info = yield* value.client.server.info();
            return { ...value, pid: info.pid };
          }),
        );
        yield* Effect.addFinalizer(() => stopByPid(connection.pid));
        assert.isFalse(connection.external);
        assert.isTrue(isAlive(connection.pid));

        const pluginList = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["plugin", "list"],
          cwd: project,
          environment,
        });
        assert.strictEqual(pluginList.code, 0);
        const cliService = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["service", "start"],
          cwd: project,
          environment,
        });
        assert.strictEqual(cliService.code, 0);
        const cliPassword = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["service", "get", "password"],
          cwd: project,
          environment,
        });
        assert.strictEqual(cliPassword.code, 0);
        const client = yield* OpenCode2Client.OpenCode2Client;
        const cliConnection = yield* client.connect({
          baseUrl: cliService.stdout.trim(),
          password: cliPassword.stdout.replace(/\r?\n$/, ""),
        });
        const cliInfo = yield* cliConnection.client.server.info();
        cliManagedPid = cliInfo.pid;
        assert.strictEqual(
          cliManagedPid,
          connection.pid,
          "plugin list used a different service process",
        );
        assert.isTrue(isAlive(connection.pid), "plugin list replaced or stopped the T3 server");

        yield* Scope.close(instanceScope, Exit.void);
        assert.isTrue(isAlive(connection.pid), "closing T3 stopped the managed OpenCode service");

        const afterClose = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["plugin", "list"],
          cwd: project,
          environment,
        });
        assert.strictEqual(afterClose.code, 0);
        const afterCloseService = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["service", "start"],
          cwd: project,
          environment,
        });
        assert.strictEqual(afterCloseService.stdout.trim(), cliService.stdout.trim());
        assert.isTrue(isAlive(connection.pid), "CLI did not reuse the service after T3 closed");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            OpenCode2Client.layer,
            NetService.layer,
            OpenCodeRuntime.OpenCodeRuntimeLive.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
        ),
      ),
    60_000,
  );

  it.live(
    "shares the managed server across locations and preserves explicit external authentication",
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
        };
        const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
        const net = yield* NetService.NetService;
        const servicePort = yield* net.reserveLoopbackPort();
        const configuredPort = yield* runtime.runOpenCodeCommand({
          binaryPath: binaryPath!,
          args: ["service", "set", "port", String(servicePort)],
          cwd: first,
          environment,
        });
        assert.strictEqual(configuredPort.code, 0);

        // Building the provider is lazy. The isolated managed service is stopped
        // by PID in a finalizer after the scope-lifetime assertion.
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
        yield* Effect.addFinalizer(() => stopByPid(spawned.pid));
        assert.match(spawned.version, /^2\./);
        assert.isFalse(spawned.external);
        assert.isTrue(isAlive(spawned.pid));

        // A second location is served by the same process.
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

        // External URL: the configured password works, a wrong one is a 401.
        const external = yield* OpenCode2Server.make({
          binaryPath: binaryPath!,
          serverUrl: spawned.url,
          serverPassword: "wrong-password",
          directory: first,
          environment,
        });
        const rejected = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(rejected.detail, "rejected the server password");
        // An external server whose password is not ASCII: OpenCode decodes Basic
        // credentials as UTF-8, so the configured password must be sent that way.
        const utf8Password = "pässwörd€";
        const externalServer = yield* startExternalServer({
          environment: { ...environment, OPENCODE_PASSWORD: utf8Password },
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
        assert.match(utf8Connection.version, /^2\./);
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

        // Closing T3 leaves the OpenCode managed service running.
        yield* Scope.close(instanceScope, Exit.void);
        assert.isTrue(isAlive(spawned.pid), `managed opencode service ${spawned.pid} was stopped`);
        yield* stopByPid(spawned.pid);
        const unreachable = yield* external.withConnection(() => Effect.void).pipe(Effect.flip);
        assert.include(unreachable.detail, "Could not reach the OpenCode server");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            OpenCode2Client.layer,
            NetService.layer,
            OpenCodeRuntime.OpenCodeRuntimeLive.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
        ),
      ),
    60_000,
  );
});
