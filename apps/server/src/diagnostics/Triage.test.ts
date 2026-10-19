import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeServerProcess, writeTriageSession } from "./Triage.ts";

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

it.effect("says the server version is unknown when the state file has none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" }),
      "server-runtime.json",
    );
    yield* fs.writeFileString(
      statePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-09-24T00:08:56.777Z",
      }),
    );

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version not recorded)`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a server-written session points the agent at a prompt file naming its context", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" });
    const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

    const session = yield* writeTriageSession({
      baseDir,
      paths,
      cliVersion: null,
      launchedAs: "T3 Code server, from the app's settings",
      startedWith: "the Triage button in T3 Code's settings",
    });

    assert.include(session.launchPrompt, session.promptFilePath);
    const prompt = yield* fs.readFileString(session.promptFilePath);
    assert.include(prompt, session.contextFilePath);
    assert.include(prompt, "the Triage button in T3 Code's settings");
    const context = yield* fs.readFileString(session.contextFilePath);
    assert.include(context, paths.dbPath);
    assert.notInclude(context, "Triage CLI version");
  }).pipe(Effect.provide(NodeServices.layer)),
);
