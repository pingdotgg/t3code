// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Windows chmod cannot force these directory or file permission failures.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

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

      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
      yield* runCli(["theme", "clear", "--base-dir", baseDir]);

      const settings = readSettings(baseDir);
      assert.equal(Object.hasOwn(settings, "defaultTheme"), false);
      assert.equal(settings.enableProviderUpdateChecks, false);
    }),
  );

  it.effect("publishes a theme file under its filename and sets it", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.existsSync(published), true);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
      const residue = NodeFS.readdirSync(NodePath.dirname(published)).filter(
        (entry) => !entry.endsWith(".json"),
      );
      assert.deepEqual(residue, []);
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

  it.effect.skipIf(!symlinksSupported)("never writes through a symlink at the staging path", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const victim = NodePath.join(baseDir, "victim.txt");
      NodeFS.writeFileSync(victim, "precious");
      NodeFS.symlinkSync(victim, NodePath.join(themesDir, `nightfall.json.staging-${process.pid}`));
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      assert.equal(NodeFS.readFileSync(victim, "utf8"), "precious");
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect.skipIf(windowsHost)("restores the previous theme when a re-publish fails to set", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {});
      const userdataDir = NodePath.dirname(settingsPathFor(baseDir));
      const themesDir = NodePath.join(userdataDir, "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const publishedPath = NodePath.join(themesDir, "nightfall.json");
      const previous =
        '{ "name": "Old Nightfall", "appearance": "dark", "canvas": "#000000", "accent": "#ffffff" }\n';
      NodeFS.writeFileSync(publishedPath, previous);
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      NodeFS.chmodSync(userdataDir, 0o555);
      try {
        yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(Effect.flip);
        assert.equal(NodeFS.readFileSync(publishedPath, "utf8"), previous);
      } finally {
        NodeFS.chmodSync(userdataDir, 0o755);
      }
    }),
  );

  it.effect.skipIf(windowsHost)("refuses to write when the settings file cannot be read", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { enableProviderUpdateChecks: false });
      NodeFS.chmodSync(settingsPathFor(baseDir), 0o000);

      const failure = yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      NodeFS.chmodSync(settingsPathFor(baseDir), 0o644);
      assert.include(String(failure), "Could not read");
      assert.equal(readSettings(baseDir).enableProviderUpdateChecks, false);
      assert.equal(Object.hasOwn(readSettings(baseDir), "defaultTheme"), false);
    }),
  );
});
