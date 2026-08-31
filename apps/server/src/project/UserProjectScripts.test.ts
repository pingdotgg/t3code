import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadUserProjectScripts } from "./UserProjectScripts.ts";

it.layer(NodeServices.layer)("loadUserProjectScripts", (it) => {
  const withStateDir = <A, E, R>(run: (stateDir: string) => Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-user-project-scripts-",
        });
        return yield* run(stateDir);
      }),
    );

  describe("user t3.json", () => {
    it.effect("returns no scripts when the file is missing", () =>
      withStateDir((stateDir) =>
        loadUserProjectScripts(stateDir).pipe(
          Effect.tap((scripts) => Effect.sync(() => expect(scripts).toEqual([]))),
        ),
      ),
    );

    it.effect("loads scripts with stable ids and Action defaults", () =>
      withStateDir((stateDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.writeFileString(
            path.join(stateDir, "t3.json"),
            `{
              "scripts": [
                { "name": "Handoff", "command": "t3-handoff action" },
                {
                  "name": "Handoff",
                  "command": "t3-handoff action --confirm",
                  "icon": "configure",
                  "runOnWorktreeCreate": true,
                  "previewUrl": "http://localhost:5173",
                  "autoOpenPreview": true
                },
                {
                  "name": "Setup",
                  "command": "pnpm install",
                  "runOnWorktreeCreate": true
                }
              ]
            }`,
          );

          const scripts = yield* loadUserProjectScripts(stateDir);

          expect(scripts).toEqual([
            {
              id: "handoff",
              name: "Handoff",
              command: "t3-handoff action",
              icon: "play",
              runOnWorktreeCreate: false,
            },
            {
              id: "handoff-2",
              name: "Handoff",
              command: "t3-handoff action --confirm",
              icon: "configure",
              runOnWorktreeCreate: false,
              previewUrl: "http://localhost:5173",
              autoOpenPreview: true,
            },
            {
              id: "setup",
              name: "Setup",
              command: "pnpm install",
              icon: "play",
              runOnWorktreeCreate: true,
            },
          ]);
        }),
      ),
    );

    it.effect("ignores an invalid file", () =>
      withStateDir((stateDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.writeFileString(path.join(stateDir, "t3.json"), "{ not-json");

          const scripts = yield* loadUserProjectScripts(stateDir);

          expect(scripts).toEqual([]);
        }),
      ),
    );
  });
});
