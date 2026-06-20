import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { WorkspaceRootNotExistsError } from "../../workspace/Services/WorkspacePaths.ts";
import { makeProjectFaviconResolver, ProjectFaviconResolverLive } from "./ProjectFaviconResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-favicon-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
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

const makeResolverWithFileSystem = (fileSystem: FileSystem.FileSystem) =>
  makeProjectFaviconResolver.pipe(
    Effect.provide(WorkspacePathsLive),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("preserves workspace normalization context", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const missingCwd = `${cwd}/missing`;

        const error = yield* resolver.resolvePath(missingCwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "normalize-workspace",
          workspaceRoot: missingCwd,
        });
        expect(error.cause).toBeInstanceOf(WorkspaceRootNotExistsError);
      }),
    );

    it.effect("preserves non-missing candidate stat failures", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const faviconPath = path.join(cwd, "favicon.svg");
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: faviconPath,
        });
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) =>
              filePath === faviconPath ? Effect.fail(cause) : fileSystem.stat(filePath),
          }),
        );

        const error = yield* resolver.resolvePath(cwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "stat-candidate",
          workspaceRoot: cwd,
          relativePath: "favicon.svg",
          absolutePath: faviconPath,
        });
        expect(error.cause).toBe(cause);
      }),
    );

    it.effect("preserves icon source read failures", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const sourcePath = path.join(cwd, "index.html");
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/favicon.svg">');
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: sourcePath,
        });
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: (filePath, options) =>
              filePath === sourcePath
                ? Effect.fail(cause)
                : fileSystem.readFileString(filePath, options),
          }),
        );

        const error = yield* resolver.resolvePath(cwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "read-source",
          workspaceRoot: cwd,
          relativePath: "index.html",
          absolutePath: sourcePath,
        });
        expect(error.cause).toBe(cause);
      }),
    );

    it.effect("skips icon metadata paths outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("continues to later sources after an outside-root icon href", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');
        yield* writeTextFile(cwd, "public/index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );
  });
});