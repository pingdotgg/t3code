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
        const find = (userSettingsLoaded = true) =>
          findNadirCompactionScript({ fileSystem, path, claudeHome, hostHome, userSettingsLoaded });
        const touch = (file: string) =>
          fileSystem
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(file, "")));
        const writeJson = (file: string, value: unknown) =>
          fileSystem.writeFileString(file, JSON.stringify(value));
        expect(yield* find()).toBeUndefined();

        const installPath = path.join(claudeHome, "plugins", "cache", "nadir-route", "1.0.0");
        const pluginScript = path.join(installPath, "scripts", "context_session.py");
        yield* touch(pluginScript);
        yield* writeJson(path.join(claudeHome, "plugins", "installed_plugins.json"), {
          plugins: { "nadir-route@nadir": [{ scope: "user", installPath }] },
        });
        expect(yield* find()).toBe(pluginScript);

        // npx nadir-labs installs the script beside the user's Claude settings.
        const labsScript = path.join(claudeHome, "nadir", "context_session.py");
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
        expect(yield* find(false)).toBe(labsScript);

        // A plugin installed only under the host's own Claude home is found from a separate one.
        const separateHome = yield* fileSystem.makeTempDirectoryScoped();
        const hostPluginPath = path.join(hostHome, ".claude", "plugins", "cache", "nadir-route");
        const hostPluginScript = path.join(hostPluginPath, "scripts", "context_session.py");
        yield* touch(hostPluginScript);
        yield* writeJson(path.join(hostHome, ".claude", "plugins", "installed_plugins.json"), {
          plugins: { "nadir-route@nadir": [{ scope: "user", installPath: hostPluginPath }] },
        });
        expect(
          yield* findNadirCompactionScript({
            fileSystem,
            path,
            claudeHome: separateHome,
            hostHome,
            userSettingsLoaded: false,
          }),
        ).toBe(hostPluginScript);

        yield* writeJson(path.join(claudeHome, "settings.json"), {
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
