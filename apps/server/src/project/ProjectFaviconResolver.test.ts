import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
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
  ProjectFaviconResolver.make.pipe(
    Effect.provide([WorkspacePaths.layer, T3ProjectFileLoader.layer]),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("prefers a t3.json iconPath over well-known files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/mark.svg" }');
        yield* writeTextFile(cwd, "brand/mark.svg", "<svg>mark</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("brand/mark.svg");
      }),
    );

    it.effect("uses a saved project favicon override", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/custom.svg", "<svg>custom</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/custom.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("brand/custom.svg");
      }),
    );

    it.effect("falls back when a saved override is missing from a checkout", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/missing.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("falls back to well-known files when the t3.json iconPath does not exist", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/missing.svg" }');
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("ignores invalid t3.json files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", "{ not json");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("does not resolve a t3.json iconPath outside the workspace root", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const parent = yield* makeTempDir;
        const cwd = `${parent}/app`;
        yield* writeTextFile(parent, "secret.svg", "<svg>secret</svg>");
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "../secret.svg" }');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("resolves icon hrefs from object-literal route metadata", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/routes/__root.tsx",
          `export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "stylesheet", href: "/app.css" },
      { rel: "icon", href: "/brand/logo.svg" },
    ],
  }),
});`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("resolves object-literal icon metadata when href precedes rel", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ href: "/brand/logo.svg", rel: "shortcut icon" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("resolves object-literal icon metadata alongside nested objects", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ attributes: {}, rel: "icon", href: "/brand/logo.svg" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("skips icon metadata without an href and keeps scanning", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/root.tsx",
          `const links = [{ rel: "icon" }, { rel: "icon", href: "/brand/logo.svg" }];`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    // A large icon source with no icon metadata used to pin the server's event loop for
    // minutes: the object pattern was unanchored, so it restarted at every offset and
    // rescanned forward from each one. Anchoring keeps this proportional to file size.
    it.effect("scans large icon sources without an icon in reasonable time", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        // Mirrors a generated single-file build: large, brace-sparse, and no icon metadata.
        const filler = `<p>${"pokopia companion guide ".repeat(24)}</p>\n`;
        yield* writeTextFile(
          cwd,
          "index.html",
          `<!doctype html><html><head><title>guide</title></head><body>\n${filler.repeat(1200)}</body></html>`,
        );

        const startedAt = performance.now();
        const resolved = yield* resolver.resolvePath(cwd);
        const elapsedMs = performance.now() - startedAt;

        expect(resolved).toBeNull();
        expect(elapsedMs).toBeLessThan(5_000);
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("preserves workspace normalization context", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const missingCwd = `${cwd}/missing`;

        const error = yield* resolver.resolvePath(missingCwd).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProjectFaviconResolutionError",
          operation: "normalize-workspace",
          workspaceRoot: missingCwd,
        });
        expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspaceRootNotExistsError);
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
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../secret.svg">');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("continues to later sources after an outside-root icon href", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
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
