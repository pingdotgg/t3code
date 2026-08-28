// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../bin.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-theme-cli-"));

const settingsPathFor = (baseDir: string) => NodePath.join(baseDir, "userdata", "settings.json");

const NIGHTFALL_THEME_JSON = `${JSON.stringify({
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
})}\n`;
const JUNK_THEME_JSON = `${JSON.stringify({ name: "Junk" })}\n`;

const readSettings = (baseDir: string): Record<string, unknown> => {
  const raw = NodeFS.readFileSync(settingsPathFor(baseDir), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
};

const writeSettings = (baseDir: string, settings: Record<string, unknown>) => {
  NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
  NodeFS.writeFileSync(settingsPathFor(baseDir), `${JSON.stringify(settings, null, 2)}\n`);
};

describe("t3 theme", () => {
  it.effect("writes a default theme when no settings file exists yet", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli(["theme", "set", "environment", "--base-dir", baseDir]);
      assert.equal(readSettings(baseDir).defaultTheme, "environment");
    }),
  );

  // A provisioning command runs against settings written by whatever version
  // happens to be installed, so it must not drop what it cannot interpret.
  it.effect("preserves settings it does not recognise", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {
        enableProviderUpdateChecks: false,
        somethingFromANewerBuild: { nested: true },
      });

      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);

      const settings = readSettings(baseDir);
      assert.equal(settings.defaultTheme, "ocean");
      assert.equal(settings.enableProviderUpdateChecks, false);
      assert.deepEqual(settings.somethingFromANewerBuild, { nested: true });
    }),
  );

  it.effect("clears the default back to leaving fresh clients alone", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { enableProviderUpdateChecks: false });

      yield* runCli(["theme", "set", "environment", "--base-dir", baseDir]);
      yield* runCli(["theme", "clear", "--base-dir", baseDir]);

      const settings = readSettings(baseDir);
      assert.equal(Object.hasOwn(settings, "defaultTheme"), false);
      assert.equal(settings.enableProviderUpdateChecks, false);
    }),
  );

  // Publishing a file and pointing at it are one step, so an integration
  // (a desktop's theme hook) needs no knowledge of the themes directory.
  it.effect("publishes a theme file under its filename and sets it", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.existsSync(published), true);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect("publishes a theme file under an explicit id", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "t3code.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", "--id", "nightfall", themeFile, "--base-dir", baseDir]);

      assert.equal(
        NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes", "nightfall.json")),
        true,
      );
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect("rejects a file that is not a theme and sets nothing", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "junk.json");
      NodeFS.writeFileSync(themeFile, JUNK_THEME_JSON);

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "not a valid theme file");
      assert.equal(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes")), false);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  // A typo'd id written as the theme would silently never resolve anywhere;
  // the id branch is as strict as the filename rule.
  it.effect("rejects an id no client could resolve", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const failure = yield* runCli(["theme", "set", "Nightfall", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "not a valid theme id");
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("rejects a path that does not exist instead of storing it as an id", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const failure = yield* runCli([
        "theme",
        "set",
        `${baseDir}/missing.json`,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(String(failure), "Could not read");
    }),
  );

  // File-ness is decided by existence, not extension, so a generated file
  // named for its target app still publishes.
  it.effect("publishes an extensionless file", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "brand");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      assert.equal(
        NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes", "brand.json")),
        true,
      );
      assert.equal(readSettings(baseDir).defaultTheme, "brand");
    }),
  );

  it.effect("records a set generation and clears it with the theme", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli(["theme", "set", "nightfall", "--base-dir", baseDir]);
      const setAt = readSettings(baseDir).defaultThemeSetAt;
      assert.equal(typeof setAt, "string");

      yield* runCli(["theme", "clear", "--base-dir", baseDir]);
      const cleared = readSettings(baseDir);
      assert.equal(Object.hasOwn(cleared, "defaultTheme"), false);
      assert.equal(Object.hasOwn(cleared, "defaultThemeSetAt"), false);
    }),
  );

  it.effect("honors T3CODE_HOME like the rest of the CLI", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli(["theme", "set", "nightfall"]).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: baseDir } })),
        ),
      );
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  // An unreadable settings file must never read as "no settings": writing a
  // fresh sparse file over it would discard every key the user had.
  it.effect("refuses to write when the settings file cannot be read", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { enableProviderUpdateChecks: false });
      NodeFS.chmodSync(settingsPathFor(baseDir), 0o000);

      const failure = yield* runCli(["theme", "set", "nightfall", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      NodeFS.chmodSync(settingsPathFor(baseDir), 0o644);
      assert.include(String(failure), "Could not read");
      assert.equal(readSettings(baseDir).enableProviderUpdateChecks, false);
      assert.equal(Object.hasOwn(readSettings(baseDir), "defaultTheme"), false);
    }),
  );

  it.effect("refuses a settings file that is not a JSON object", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
      NodeFS.writeFileSync(settingsPathFor(baseDir), "[1, 2, 3]\n");

      const failure = yield* runCli(["theme", "set", "environment", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "not a JSON object");
    }),
  );
});
