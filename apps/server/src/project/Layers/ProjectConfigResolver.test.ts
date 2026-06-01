import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PROJECT_CONFIG_RELATIVE_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectConfigResolver } from "../Services/ProjectConfigResolver.ts";
import { ProjectConfigResolverLive } from "./ProjectConfigResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectConfigResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-config-",
  });
});

const writeTextFile = Effect.fn("writeProjectConfigTestFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectConfigResolverLive", (it) => {
  describe("resolve", () => {
    it.effect("returns undefined values when config is missing", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectConfigResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolve({ cwd });

        expect(resolved.scripts).toBeUndefined();
        expect(resolved.browserPreviewUrl).toBeUndefined();
      }),
    );

    it.effect("parses scripts and browser preview URL", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectConfigResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          PROJECT_CONFIG_RELATIVE_PATH,
          `{
            "browser": { "previewUrl": ":5173" },
            "scripts": [
              {
                "id": "dev",
                "name": "Dev",
                "command": "bun dev",
                "icon": "play",
                "runOnWorktreeCreate": false
              }
            ]
          }`,
        );

        const resolved = yield* resolver.resolve({ cwd });

        expect(resolved.browserPreviewUrl).toBe("http://localhost:5173");
        expect(resolved.scripts?.[0]?.id).toBe("dev");
      }),
    );

    it.effect("ignores invalid JSON", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectConfigResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, PROJECT_CONFIG_RELATIVE_PATH, "{ invalid");

        const resolved = yield* resolver.resolve({ cwd });

        expect(resolved.scripts).toBeUndefined();
        expect(resolved.browserPreviewUrl).toBeUndefined();
      }),
    );

    it.effect("ignores script overrides with duplicate ids", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectConfigResolver;
        const cwd = yield* makeTempDir;
        const script = {
          raw: `{
            "id": "dev",
            "name": "Dev",
            "command": "bun dev",
            "icon": "play",
            "runOnWorktreeCreate": false
          }`,
        } as const;
        yield* writeTextFile(
          cwd,
          PROJECT_CONFIG_RELATIVE_PATH,
          `{
            "scripts": [${script.raw}, ${script.raw}]
          }`,
        );

        const resolved = yield* resolver.resolve({ cwd });

        expect(resolved.scripts).toBeUndefined();
      }),
    );
  });
});
