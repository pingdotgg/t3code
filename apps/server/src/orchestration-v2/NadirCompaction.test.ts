import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findNadirCompactionScript,
  nadirCompactionHooks,
  withExtraHooks,
} from "./NadirCompaction.ts";

it.layer(NodeServices.layer)("NadirCompaction", (it) => {
  describe("findNadirCompactionScript", () => {
    it.effect("finds an installed script unless the loaded Claude settings already run it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const claudeHome = yield* fileSystem.makeTempDirectoryScoped();
        const hostHome = yield* fileSystem.makeTempDirectoryScoped();
        const userSettings = path.join(claudeHome, "settings.json");
        const find = (settingsFiles: ReadonlyArray<string> = [userSettings]) =>
          findNadirCompactionScript({ fileSystem, path, claudeHome, hostHome, settingsFiles });
        const touch = (file: string) =>
          fileSystem
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(file, "")));
        const writeJson = (file: string, value: unknown) =>
          fileSystem.writeFileString(file, JSON.stringify(value));
        expect(yield* find()).toBeUndefined();
        const labsScript = path.join(claudeHome, "nadir", "context_session.py");
        yield* fileSystem.makeDirectory(labsScript, { recursive: true });
        expect(yield* find()).toBeUndefined();
        yield* fileSystem.remove(labsScript, { recursive: true });

        const installPath = path.join(claudeHome, "plugins", "cache", "nadir-route", "1.0.0");
        const pluginScript = path.join(installPath, "scripts", "context_session.py");
        yield* touch(pluginScript);
        yield* writeJson(path.join(claudeHome, "plugins", "installed_plugins.json"), {
          plugins: { "nadir-route@nadir": [{ scope: "user", installPath }] },
        });
        expect(yield* find()).toBe(pluginScript);

        // The host's own nadir-labs install outranks a plugin, and a malformed entry is ignored.
        const hostLabsScript = path.join(hostHome, ".claude", "nadir", "context_session.py");
        yield* touch(hostLabsScript);
        expect(yield* find()).toBe(hostLabsScript);
        yield* writeJson(path.join(claudeHome, "plugins", "installed_plugins.json"), {
          plugins: { "nadir-route@nadir": [{ installPath: 42 }] },
        });
        expect(yield* find()).toBe(hostLabsScript);
        yield* fileSystem.remove(hostLabsScript);

        // npx nadir-labs installs the script beside the user's Claude settings.
        yield* touch(labsScript);
        expect(yield* find()).toBe(labsScript);

        yield* writeJson(path.join(claudeHome, "settings.json"), {
          hooks: {
            PostToolUse: [
              {
                matcher: "Read|Bash",
                hooks: [{ type: "command", command: `python3 ${labsScript}` }],
              },
            ],
          },
        });
        expect(yield* find()).toBeUndefined();
        // A separate T3 Claude home skips user settings, so T3 must add the hooks itself.
        expect(yield* find([])).toBe(labsScript);
        // Project and local settings load either way, and a repo can enable Nadir there.
        const projectSettings = path.join(hostHome, "repo", ".claude", "settings.local.json");
        yield* touch(projectSettings);
        yield* writeJson(projectSettings, { enabledPlugins: { "nadir-route@nadir": true } });
        expect(yield* find([projectSettings])).toBeUndefined();

        // A plugin installed only under the host's own Claude home is found from a separate one.
        const separateHome = yield* fileSystem.makeTempDirectoryScoped();
        const hostPluginPath = path.join(hostHome, ".claude", "plugins", "cache", "nadir-route");
        const hostPluginScript = path.join(hostPluginPath, "scripts", "context_session.py");
        yield* touch(hostPluginScript);
        // The first install is stale; the second still has the script.
        yield* writeJson(path.join(hostHome, ".claude", "plugins", "installed_plugins.json"), {
          plugins: {
            "nadir-route@nadir": [
              { scope: "user", installPath: path.join(hostHome, "gone") },
              { scope: "project", installPath: hostPluginPath },
            ],
          },
        });
        expect(
          yield* findNadirCompactionScript({
            fileSystem,
            path,
            claudeHome: separateHome,
            hostHome,
            settingsFiles: [],
          }),
        ).toBe(hostPluginScript);

        yield* writeJson(userSettings, {
          enabledPlugins: { "nadir-route@nadir": true },
        });
        expect(yield* find()).toBeUndefined();
      }).pipe(Effect.scoped),
    );
  });

  it("adds Nadir's hooks after the user's own", () => {
    const own = { type: "command" as const, command: "own-hook" };
    const settings = withExtraHooks(
      { env: { KEPT: "1" }, hooks: { PostToolUse: [{ matcher: "Write", hooks: [own] }] } },
      nadirCompactionHooks("/plugin/scripts/context_session.py", "/home/.nadir/context"),
    );
    expect(settings.env).toEqual({ KEPT: "1" });
    expect(settings.hooks?.PostToolUse?.map((entry) => entry.matcher)).toEqual([
      "Write",
      "Read|Bash",
    ]);
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]).toMatchObject({
      command: "python3",
      args: [
        "/plugin/scripts/context_session.py",
        "--state-dir",
        "/home/.nadir/context",
        "--max-chars",
        "8000",
        "--no-policy",
      ],
    });
  });
});
