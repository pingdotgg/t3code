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
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// These force a failure with chmod, which Windows ignores for directories and
// cannot use to make a file unreadable, so the failure never happens there.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

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
      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
      assert.equal(readSettings(baseDir).defaultTheme, "ocean");
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

      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
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
      // No rollback or staging residue after a successful set.
      const residue = NodeFS.readdirSync(NodePath.dirname(published)).filter(
        (entry) => !entry.endsWith(".json"),
      );
      assert.deepEqual(residue, []);
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

  // Publish and set are one command, so a settings file the set step cannot
  // use must fail it before the themes directory is mutated -- not after,
  // with a half-applied publish left behind.
  it.effect("publishes nothing when the settings file cannot be used", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
      NodeFS.writeFileSync(settingsPathFor(baseDir), "{ not json");
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "not a JSON object");
      assert.equal(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes")), false);
    }),
  );

  // set means set: a publish that rode along with a failed default write is
  // rolled back rather than left mutating the environment's theme set. The
  // userdata directory is made read-only while themes stays writable, so the
  // failure lands after the publish -- the case the rollback exists for.
  it.effect.skipIf(windowsHost)("rolls back a publish when the default cannot be written", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {});
      const userdataDir = NodePath.dirname(settingsPathFor(baseDir));
      const themesDir = NodePath.join(userdataDir, "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      NodeFS.chmodSync(userdataDir, 0o555);
      try {
        const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
          Effect.flip,
        );
        assert.include(String(failure), "Could not write");
        assert.equal(NodeFS.existsSync(NodePath.join(themesDir, "nightfall.json")), false);
      } finally {
        NodeFS.chmodSync(userdataDir, 0o755);
      }
    }),
  );

  // A symlink is a normal way to hand this command a theme -- desktop hooks
  // symlink the current palette -- so the source is resolved, not refused.
  it.effect.skipIf(!symlinksSupported)(
    "publishes a theme file through a symlinked source path",
    () =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const realFile = NodePath.join(baseDir, "real-nightfall.json");
        NodeFS.writeFileSync(realFile, NIGHTFALL_THEME_JSON);
        const linkPath = NodePath.join(baseDir, "nightfall.json");
        NodeFS.symlinkSync(realFile, linkPath);

        yield* runCli(["theme", "set", linkPath, "--base-dir", baseDir]);

        assert.equal(
          NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes", "nightfall.json")),
          true,
        );
        assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
      }),
  );

  // The staging entry is created fresh with O_EXCL, so a symlink planted at
  // its predictable name is cleared, never followed and written through.
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

  // Rollback moves the previous directory entry aside and back, so even an
  // entry the watcher would never publish -- here a symlink -- comes back
  // exactly as it was when the set fails.
  it.effect.skipIf(!symlinksSupported || windowsHost)(
    "restores a non-theme destination entry when the set fails",
    () =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        writeSettings(baseDir, {});
        const userdataDir = NodePath.dirname(settingsPathFor(baseDir));
        const themesDir = NodePath.join(userdataDir, "themes");
        NodeFS.mkdirSync(themesDir, { recursive: true });
        const outside = NodePath.join(baseDir, "outside.json");
        NodeFS.writeFileSync(outside, NIGHTFALL_THEME_JSON);
        const destination = NodePath.join(themesDir, "nightfall.json");
        NodeFS.symlinkSync(outside, destination);
        const themeFile = NodePath.join(baseDir, "nightfall.json");
        NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

        NodeFS.chmodSync(userdataDir, 0o555);
        try {
          yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(Effect.flip);
          assert.equal(NodeFS.lstatSync(destination).isSymbolicLink(), true);
        } finally {
          NodeFS.chmodSync(userdataDir, 0o755);
        }
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
      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
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
      yield* runCli(["theme", "set", "ocean"]).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: baseDir } })),
        ),
      );
      assert.equal(readSettings(baseDir).defaultTheme, "ocean");
    }),
  );

  // An unreadable settings file must never read as "no settings": writing a
  // fresh sparse file over it would discard every key the user had.
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

  // A typo is syntactically a valid id, so shape validation alone would write
  // a theme no client can resolve and report success.
  it.effect("rejects an id that names no theme", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const failure = yield* runCli(["theme", "set", "ocian", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "No theme named");
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("accepts an id a published file provides", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      // Now resolvable by bare id, because the file published it.
      yield* runCli(["theme", "clear", "--base-dir", baseDir]);
      yield* runCli(["theme", "set", "nightfall", "--base-dir", baseDir]);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  // The watcher skips files it cannot use, so accepting their filename would
  // set a theme no client ever receives.
  it.effect("rejects an id whose published file the watcher would skip", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(themesDir, "broken.json"), "{ not json\n");

      const failure = yield* runCli(["theme", "set", "broken", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "No theme named");
    }),
  );

  // Web and desktop cannot resolve the mobile default, and mobile does not
  // follow this setting, so naming it would be a silent no-op.
  it.effect("rejects the mobile default theme id", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const failure = yield* runCli(["theme", "set", "t3-code", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "No theme named");
    }),
  );

  // Deciding on existence alone would publish ./ocean instead of selecting the
  // built-in, purely because of what happens to be in the working directory.
  it.effect("treats a bare id as an id even when a file shares its name", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const cwdFile = NodePath.join(baseDir, "ocean");
      NodeFS.writeFileSync(cwdFile, NIGHTFALL_THEME_JSON);

      const previous = process.cwd();
      process.chdir(baseDir);
      try {
        yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
      } finally {
        process.chdir(previous);
      }

      assert.equal(readSettings(baseDir).defaultTheme, "ocean");
      assert.equal(
        NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes", "ocean.json")),
        false,
      );
    }),
  );

  // The watcher would skip an oversized file, so publishing one must not
  // report success for a theme no client receives.
  it.effect("rejects a theme file larger than the watcher will read", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "huge.json");
      const padding = "x".repeat(40 * 1024);
      NodeFS.writeFileSync(
        themeFile,
        `{ "name": "Huge", "appearance": "dark", "canvas": "#1a1b26", "accent": "#7aa2f7", "note": "${padding}" }\n`,
      );

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );
      assert.include(String(failure), "larger than");
    }),
  );

  it.effect("refuses a settings file that is not a JSON object", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
      NodeFS.writeFileSync(settingsPathFor(baseDir), "[1, 2, 3]\n");

      const failure = yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "not a JSON object");
    }),
  );
});
