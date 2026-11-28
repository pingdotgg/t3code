// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { lock } from "proper-lockfile";
import { vi } from "vite-plus/test";

import { cli } from "../binCli.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs", { spy: true });

// Windows chmod cannot force these directory or file permission failures.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  );

const runCliIn = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd();
      process.chdir(cwd);
      return previous;
    }),
    () => runCli(args),
    (previous) => Effect.sync(() => process.chdir(previous)),
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

  it.effect("sets the theme of a dev server running in the default home", () =>
    Effect.gen(function* () {
      const home = makeBaseDir();
      const devStateDir = NodePath.join(home, ".t3", "dev");
      NodeFS.mkdirSync(devStateDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(devStateDir, "server-runtime.json"),
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 4888,
          origin: "http://127.0.0.1:4888",
          devUrl: "http://127.0.0.1:5999",
          startedAt: "1970-01-01T00:00:00.000Z",
        })}\n`,
      );

      const result = yield* runCli(["theme", "set", "ocean"]).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.result,
      );

      assert.equal(
        NodeFS.existsSync(NodePath.join(home, ".t3", "userdata", "settings.json")),
        false,
      );
      if (result._tag === "Success") {
        const devSettings = NodePath.join(devStateDir, "settings.json");
        assert.equal(JSON.parse(NodeFS.readFileSync(devSettings, "utf8")).defaultTheme, "ocean");
      }
    }),
  );

  it.effect.each([
    { extension: "json", relativePath: null },
    { extension: "JSON", relativePath: "nightfall.JSON" },
  ])(
    "publishes a .$extension theme file under its filename and sets it",
    ({ extension, relativePath }) =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const themeFile = NodePath.join(baseDir, `nightfall.${extension}`);
        NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

        yield* runCliIn(baseDir, [
          "theme",
          "set",
          relativePath ?? themeFile,
          "--base-dir",
          baseDir,
        ]);

        const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
        assert.equal(NodeFS.readFileSync(published, "utf8"), NIGHTFALL_THEME_JSON);
        assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
        const residue = NodeFS.readdirSync(NodePath.dirname(published)).filter(
          (entry) => !entry.endsWith(".json"),
        );
        assert.deepEqual(residue, []);
      }),
  );

  it.effect("publishes the file named with a leading space, not its trimmed sibling", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.mkdirSync(NodePath.join(baseDir, " palettes"));
      NodeFS.mkdirSync(NodePath.join(baseDir, "palettes"));
      NodeFS.writeFileSync(
        NodePath.join(baseDir, " palettes", "nightfall.json"),
        NIGHTFALL_THEME_JSON,
      );
      NodeFS.writeFileSync(NodePath.join(baseDir, "palettes", "nightfall.json"), JUNK_THEME_JSON);

      yield* runCliIn(baseDir, ["theme", "set", " palettes/nightfall.json", "--base-dir", "."]);

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.readFileSync(published, "utf8"), NIGHTFALL_THEME_JSON);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect("refuses --id with a theme id, which has no file to publish", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();

      const exit = yield* runCli([
        "theme",
        "set",
        "ocean",
        "--id",
        "nightfall",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.include(String(exit), "--id");
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  // Win32 resolves both names to one file.
  it.effect.skipIf(windowsHost)("publishes a file whose name ends in a space", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.writeFileSync(NodePath.join(baseDir, "nightfall.json "), NIGHTFALL_THEME_JSON);
      NodeFS.writeFileSync(NodePath.join(baseDir, "nightfall.json"), JUNK_THEME_JSON);

      yield* runCliIn(baseDir, [
        "theme",
        "set",
        "nightfall.json ",
        "--id",
        "nightfall",
        "--base-dir",
        ".",
      ]);

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.readFileSync(published, "utf8"), NIGHTFALL_THEME_JSON);
    }),
  );

  // Simulates Win32 on other hosts; on Windows itself the two fixtures would be one file.
  it.effect.skipIf(windowsHost)("drops trailing spaces from the path on Windows", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      NodeFS.writeFileSync(`${themeFile} `, JUNK_THEME_JSON);

      yield* runCli(["theme", "set", `${themeFile} `, "--base-dir", baseDir]).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.readFileSync(published, "utf8"), NIGHTFALL_THEME_JSON);
    }),
  );

  it.effect("still trims a path that only names a file once trimmed", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "palettes", "nightfall.json");
      NodeFS.mkdirSync(NodePath.dirname(themeFile));
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      NodeFS.mkdirSync(NodePath.join(baseDir, " palettes", "nightfall.json"), { recursive: true });

      yield* runCliIn(baseDir, ["theme", "set", " palettes/nightfall.json", "--base-dir", "."]);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect("refuses to publish over a directory with the theme's file name", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const taken = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      NodeFS.mkdirSync(taken, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(taken, "notes.txt"), "notes");
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "is a directory");
      assert.equal(NodeFS.readFileSync(NodePath.join(taken, "notes.txt"), "utf8"), "notes");
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(taken)), ["nightfall.json"]);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("refuses to publish over a directory created just before backup", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      const destination = NodePath.join(themesDir, "nightfall.json");
      const notes = NodePath.join(destination, "notes.txt");
      const { renameSync } = yield* Effect.promise(() => vi.importActual<typeof NodeFS>("node:fs"));
      using _insertDirectory = vi.spyOn(NodeFS, "renameSync").mockImplementationOnce((from, to) => {
        NodeFS.mkdirSync(destination);
        NodeFS.writeFileSync(notes, "notes");
        renameSync(from, to);
      });

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "is a directory");
      assert.equal(NodeFS.readFileSync(notes, "utf8"), "notes");
      assert.deepEqual(NodeFS.readdirSync(themesDir), ["nightfall.json"]);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("publishes a theme despite a rollback file left by an earlier process", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      const destination = NodePath.join(themesDir, "nightfall.json");
      const staleBackup = `${destination}.rollback-${process.pid}`;
      NodeFS.mkdirSync(themesDir, { recursive: true });
      NodeFS.writeFileSync(staleBackup, "previous theme");

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
      assert.equal(NodeFS.readFileSync(destination, "utf8"), NIGHTFALL_THEME_JSON);
      assert.equal(NodeFS.readFileSync(staleBackup, "utf8"), "previous theme");
      assert.deepEqual(NodeFS.readdirSync(themesDir).sort(), [
        "nightfall.json",
        NodePath.basename(staleBackup),
      ]);
    }),
  );

  it.effect.each(["aa-first", "zz-last"])(
    "refuses to publish %s into a full theme catalog",
    (themeId) =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const themesDir = NodePath.join(baseDir, "userdata", "themes");
        const existingThemes = Array.from(
          { length: 32 },
          (_, index) => `theme-${String(index).padStart(2, "0")}.json`,
        );
        const previousSettings = {
          defaultTheme: "theme-31",
          defaultThemeSetAt: "2026-01-01T00:00:00Z",
        };
        writeSettings(baseDir, previousSettings);
        NodeFS.mkdirSync(themesDir);
        for (const filename of existingThemes) {
          NodeFS.writeFileSync(NodePath.join(themesDir, filename), NIGHTFALL_THEME_JSON);
        }
        const themeFile = NodePath.join(baseDir, `${themeId}.json`);
        NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

        const outcome = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
          Effect.match({ onFailure: String, onSuccess: () => "theme set succeeded" }),
        );

        assert.include(outcome, `Theme "${themeId}" could not be published.`);
        assert.deepEqual(NodeFS.readdirSync(themesDir).sort(), existingThemes);
        assert.deepEqual(readSettings(baseDir), previousSettings);
      }),
  );

  it.effect("keeps the theme catalog and settings when another publisher holds the lock", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      const previousSettings = { defaultTheme: "original" };
      writeSettings(baseDir, previousSettings);
      NodeFS.mkdirSync(themesDir);
      NodeFS.writeFileSync(NodePath.join(themesDir, "original.json"), NIGHTFALL_THEME_JSON);
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const outcome = yield* Effect.acquireUseRelease(
        Effect.promise(() =>
          lock(themesDir, { lockfilePath: NodePath.join(themesDir, ".t3-theme-publish.lock") }),
        ),
        () =>
          runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
            Effect.match({ onFailure: String, onSuccess: () => "theme set succeeded" }),
          ),
        (release) => Effect.promise(() => release()),
      );

      assert.include(outcome, "is busy");
      assert.deepEqual(NodeFS.readdirSync(themesDir), ["original.json"]);
      assert.deepEqual(readSettings(baseDir), previousSettings);
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
