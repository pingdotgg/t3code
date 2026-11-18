import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, type Daemon, DaemonId, type DaemonUpsertInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { daemonCommand } from "./daemon.ts";
import * as DaemonRpc from "./daemonRpc.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          method: "bearer-access-token" as const,
          scopes: [],
          subject: "test",
          client: { deviceType: "bot" as const },
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const daemon = (id: string): Daemon => ({
  id: DaemonId.make(id),
  name: "web",
  command: "vp run dev",
  cwd: "/srv/app",
  enabled: true,
  status: {
    state: "running",
    pid: 42,
    startedAt: null,
    nextAttemptAt: null,
    lastExitCode: null,
    lastExitAt: null,
    lastError: null,
  },
});

/** A running server whose daemon RPCs record their payloads. */
const liveServer = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-daemon-cli-" })
    .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
  const baseDir = path.join(root, "state");
  yield* persistServerRuntimeState({
    path: path.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    }),
  });
  const upserts: Array<DaemonUpsertInput> = [];
  const client = {
    // The real subscription never ends; `list` must stop after the snapshot.
    "daemons.subscribe": () =>
      Stream.concat(Stream.make({ daemons: [daemon("d-1")] }), Stream.never),
    "daemons.upsert": (input: DaemonUpsertInput) => {
      upserts.push(input);
      return Effect.succeed({ daemon: daemon(input.id ?? "new-id") });
    },
  } as unknown as DaemonRpc.DaemonRpcClient;
  const session = vi.spyOn(DaemonRpc, "daemonRpcSession").mockReturnValue(Effect.succeed(client));
  yield* Effect.addFinalizer(() => Effect.sync(() => session.mockRestore()));
  return { root, baseDir, upserts };
});

const runDaemon = (args: ReadonlyArray<string>) =>
  Command.runWith(daemonCommand, { version: "0.0.0" })(args);

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
);

it.effect("add maps its flags to the upsert payload and prints the id", () =>
  Effect.gen(function* () {
    const { root, baseDir, upserts } = yield* liveServer();
    const path = yield* Path.Path;
    const home = path.join(root, "home");
    const cwd = path.join(root, "current");
    const inDirectories = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );

    yield* inDirectories(
      runDaemon(["add", "--name", " web ", "--command", "vp run dev", "--base-dir", baseDir]),
    );
    yield* inDirectories(
      runDaemon([
        "add",
        "--id",
        "d-1",
        "--name",
        "web",
        "--command",
        "vp run dev",
        "--cwd",
        "~/app",
        "--disabled",
        "--base-dir",
        baseDir,
      ]),
    );

    assert.deepStrictEqual(upserts, [
      { name: "web", command: "vp run dev", cwd, enabled: true },
      {
        id: DaemonId.make("d-1"),
        name: "web",
        command: "vp run dev",
        cwd: path.join(home, "app"),
        enabled: false,
      },
    ]);
    assert.deepStrictEqual(yield* TestConsole.logLines, ["new-id", "d-1"]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("list prints the current daemons instead of following the subscription", () =>
  Effect.gen(function* () {
    const { baseDir } = yield* liveServer();

    yield* runDaemon(["list", "--json", "--base-dir", baseDir]);

    assert.deepStrictEqual(JSON.parse(String((yield* TestConsole.logLines).at(-1))), [
      daemon("d-1"),
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
