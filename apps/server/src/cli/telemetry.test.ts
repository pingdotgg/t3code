// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const makeBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-telemetry-cli-"));

const settingsPathFor = (baseDir: string) => NodePath.join(baseDir, "userdata", "settings.json");

const readSettings = (baseDir: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(settingsPathFor(baseDir), "utf8")) as Record<string, unknown>;

describe("t3 telemetry", () => {
  it.effect("turns the setting off and back on, keeping other settings", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
      NodeFS.writeFileSync(
        settingsPathFor(baseDir),
        `${JSON.stringify({ somethingFromANewerBuild: { nested: true } })}\n`,
      );

      yield* runCli(["telemetry", "off", "--base-dir", baseDir]);
      assert.deepEqual(readSettings(baseDir), {
        somethingFromANewerBuild: { nested: true },
        telemetryEnabled: false,
      });
      const off = yield* runCli(["telemetry", "status", "--base-dir", baseDir]);
      assert.isTrue(off.some((line) => String(line).startsWith("Telemetry setting: off")));

      yield* runCli(["telemetry", "on", "--base-dir", baseDir]);
      assert.deepEqual(readSettings(baseDir), { somethingFromANewerBuild: { nested: true } });
      const on = yield* runCli(["telemetry", "status", "--base-dir", baseDir]);
      assert.isTrue(on.some((line) => String(line).startsWith("Telemetry setting: on")));
    }),
  );

  it.effect("says when the variable in this shell overrides the setting", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const lines = yield* runCli(["telemetry", "status", "--base-dir", baseDir], {
        T3CODE_TELEMETRY_ENABLED: "false",
      });
      assert.isTrue(
        lines.some((line) => String(line).startsWith("T3CODE_TELEMETRY_ENABLED=false is set")),
      );
    }),
  );
});
