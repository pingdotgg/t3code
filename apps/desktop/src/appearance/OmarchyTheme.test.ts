import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  makeOmarchyThemeChangeStream,
  readOmarchyThemeFile,
  resolveOmarchyThemePaths,
} from "./OmarchyTheme.ts";

describe("OmarchyTheme", () => {
  it.effect("is absent off Linux and when Omarchy has no generated theme", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omarchy-" });
      assert.isNull(yield* readOmarchyThemeFile({ homeDirectory, platform: "darwin" }));
      assert.isNull(yield* readOmarchyThemeFile({ homeDirectory, platform: "linux" }));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Omarchy's generated palette from the stable current tree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omarchy-" });
      const paths = resolveOmarchyThemePaths(homeDirectory, path);
      yield* fileSystem.makeDirectory(paths.themeDirectory, { recursive: true });
      yield* fileSystem.writeFileString(paths.themeFile, '{"name":"Omarchy"}');

      assert.deepEqual(yield* readOmarchyThemeFile({ homeDirectory, platform: "linux" }), {
        name: "vscode-theme.json",
        size: 18,
        text: '{"name":"Omarchy"}',
      });
      assert.equal(
        paths.currentDirectory,
        path.join(homeDirectory, ".local/state/omarchy/current"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not emit a removal during Omarchy's remove-then-move swap gap", () =>
    Effect.gen(function* () {
      const nextTheme = {
        name: "vscode-theme.json",
        size: 17,
        text: '{"name":"Next"}',
      };
      const reads = [null, nextTheme] as Array<typeof nextTheme | null>;
      let readCount = 0;
      const changes = yield* makeOmarchyThemeChangeStream(
        Stream.make("remove current/theme", "move next-theme to current/theme"),
        Effect.sync(() => {
          readCount += 1;
          return reads.length > 0 ? reads.shift()! : nextTheme;
        }),
        {
          debounce: Duration.zero,
          missingRetries: 3,
          missingRetryDelay: Duration.zero,
        },
      ).pipe(Stream.runCollect);

      assert.deepEqual(changes, [nextTheme]);
      assert.isEmpty(reads);
      assert.isAtLeast(readCount, 2);
    }),
  );

  it.effect("emits removal after a missing generated theme is confirmed", () =>
    Effect.gen(function* () {
      let readCount = 0;
      const changes = yield* makeOmarchyThemeChangeStream(
        Stream.make("remove current/theme"),
        Effect.sync(() => {
          readCount += 1;
          return null;
        }),
        {
          debounce: Duration.zero,
          missingRetries: 2,
          missingRetryDelay: Duration.zero,
        },
      ).pipe(Stream.runCollect);

      assert.deepEqual(changes, [null]);
      assert.equal(readCount, 3);
    }),
  );
});
