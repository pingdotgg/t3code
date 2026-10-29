import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

/** Runs one command and returns what it printed. */
const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        Layer.fresh(TestConsole.layer),
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      ),
    ),
  );

const makeBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-telemetry-cli-" });
  return { baseDir, settingsPath: path.join(baseDir, "userdata", "settings.json") };
});

const readSettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return JSON.parse(yield* fs.readFileString(settingsPath)) as Record<string, unknown>;
});

it.layer(NodeServices.layer)("t3 telemetry", (it) => {
  it.effect("turns the setting off and back on, keeping other settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, settingsPath } = yield* makeBaseDir;
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(
        settingsPath,
        `${JSON.stringify({ somethingFromANewerBuild: { nested: true } })}\n`,
      );

      yield* runCli(["telemetry", "off", "--base-dir", baseDir]);
      assert.deepEqual(yield* readSettings(settingsPath), {
        somethingFromANewerBuild: { nested: true },
        telemetryEnabled: false,
      });
      const off = yield* runCli(["telemetry", "status", "--base-dir", baseDir]);
      assert.isTrue(off.some((line) => String(line).startsWith("Telemetry setting: off")));

      yield* runCli(["telemetry", "on", "--base-dir", baseDir]);
      assert.deepEqual(yield* readSettings(settingsPath), {
        somethingFromANewerBuild: { nested: true },
      });
      const on = yield* runCli(["telemetry", "status", "--base-dir", baseDir]);
      assert.isTrue(on.some((line) => String(line).startsWith("Telemetry setting: on")));
    }).pipe(Effect.scoped),
  );

  it.effect("says when the variable in this shell overrides the setting", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* makeBaseDir;
      const lines = yield* runCli(["telemetry", "status", "--base-dir", baseDir], {
        T3CODE_TELEMETRY_ENABLED: "false",
      });
      assert.isTrue(
        lines.some((line) => String(line).startsWith("T3CODE_TELEMETRY_ENABLED=false is set")),
      );
    }).pipe(Effect.scoped),
  );
});
