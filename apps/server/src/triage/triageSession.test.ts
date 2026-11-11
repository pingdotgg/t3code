import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeServerProcess, writeTriageSession } from "./triageSession.ts";

it.effect.each([
  { name: "HOME is missing", home: undefined, accountHomeAvailable: true },
  { name: "no home is available", home: "", accountHomeAvailable: false },
])("writes an absolute macOS service log path when $name", ({ home, accountHomeAvailable }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-home-" });
    const baseDir = path.join(root, "data");
    const accountHome = accountHomeAvailable ? path.join(root, "account") : "";
    const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

    const session = yield* writeTriageSession({
      baseDir,
      paths,
      entry: { kind: "cli", cliVersion: packageJson.version, launchedAs: "t3 triage" },
      server: "not running",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.HomeDirectory, accountHome),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: home === undefined ? {} : { HOME: home } }),
          ),
        ),
      ),
    );

    const context = yield* fs.readFileString(session.contextFilePath);
    const expectedLogPath = accountHomeAvailable
      ? path.join(accountHome, "Library", "Logs", "T3Code", "boot-service.log")
      : path.join(baseDir, "userdata", "logs", "boot-service.log");
    assert.include(
      context,
      `Service log (systemd/launchd service installs only): ${expectedLogPath}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports the version the running server recorded, not the CLI's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" }),
      "server-runtime.json",
    );
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: statePath, state });

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version ${packageJson.version})`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
