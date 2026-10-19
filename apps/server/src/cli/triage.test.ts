import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeServerProcess } from "./triage.ts";

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
