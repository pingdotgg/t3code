import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as WorkspaceIoGate from "../workspace/WorkspaceIoGate.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
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
    Effect.provideService(
      WorkspaceIoGate.WorkspaceIoGate,
      WorkspaceIoGate.makeWorkspaceIoGate({ maxInFlight: 2, timeout: "10 seconds" }),
    ),
  );

it.layer(layerTest)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("finds a favicon added after a cached miss once the workspace is invalidated", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        // A clone's project exists while its folder is still empty.
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        yield* writeTextFile(cwd, "favicon.ico", "icon");
        expect(yield* resolver.resolvePath(cwd)).toBeNull();

        yield* resolver.invalidate(cwd);
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.ico"));
      }),
    );

    it.effect("falls back at once when a cached favicon is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        expect(yield* resolver.resolvePath(cwd)).not.toBeNull();

        yield* fileSystem.remove(path.join(cwd, "favicon.svg")).pipe(Effect.orDie);

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("finds the best app icon in a monorepo without a root icon", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // An Expo app sorts first, but a web app's favicon is a better match.
        yield* writeTextFile(cwd, "apps/mobile-app/assets/images/icon.png", "png");
        yield* writeTextFile(cwd, "apps/web-app/public/favicon.svg", "<svg>web</svg>");
        yield* writeTextFile(cwd, "apps/.hidden/favicon.svg", "<svg>hidden</svg>");

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "apps", "web-app", "public", "favicon.svg"),
        );
      }),
    );

    it.effect("finds an Expo app icon when it is the only app icon", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "apps/mobile-app/assets/images/icon.png", "png");
        yield* writeTextFile(cwd, "apps/README.md", "not an app");

        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "apps", "mobile-app", "assets", "images", "icon.png"),
        );
      }),
    );

    it.effect("prefers a root icon over app icons", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "apps/web/favicon.svg", "<svg>app</svg>");
        yield* writeTextFile(cwd, "app/favicon.ico", "ico");

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "app", "favicon.ico"));
      }),
    );

    it.effect("prefers a t3.json iconPath over well-known files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "t3.json", '{ "iconPath": "brand/mark.svg" }');
        yield* writeTextFile(cwd, "brand/mark.svg", "<svg>mark</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "mark.svg"));
      }),
    );

    it.effect("uses a saved project favicon override", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/custom.svg", "<svg>custom</svg>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>automatic</svg>");

        const resolved = yield* resolver.resolvePath(cwd, "brand/custom.svg");

        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(cwd, "brand", "custom.svg"));
      }),
    );

    it.effect("uses a saved project favicon outside the workspace", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(pictures, "custom.png", "image");
        const externalPath = path.join(pictures, "custom.png");

        const resolved = yield* resolver.resolvePath(cwd, externalPath);

        expect(resolved).toBe(externalPath);
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
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
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
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    // regression: #5538 favicon resolution pinned the event loop
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
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));
      }),
    );

    it.effect("returns a found favicon without waiting for lower-ranked probes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>root</svg>");
        const stuckPath = path.join(cwd, "favicon.ico");
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) => (filePath === stuckPath ? Effect.never : fileSystem.stat(filePath)),
          }),
        );

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
      }),
    );

    it.effect("pauses a folder that stops answering while other projects keep resolving", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hungRoot = yield* makeTempDir;
        const healthyRoot = yield* makeTempDir;
        yield* writeTextFile(healthyRoot, "favicon.svg", "<svg>healthy</svg>");
        const firstHungStat = yield* Deferred.make<void>();
        let hungStats = 0;
        // Like a stat on a dead mount, which never returns.
        const hungStat = Effect.suspend(() => {
          hungStats += 1;
          return Deferred.succeed(firstHungStat, undefined);
        }).pipe(Effect.andThen(Effect.never));
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) =>
              filePath.startsWith(hungRoot + path.sep) ? hungStat : fileSystem.stat(filePath),
          }),
        );

        const resolving = yield* resolver.resolvePath(hungRoot).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(firstHungStat);
        yield* TestClock.adjust("10 seconds");
        const error = yield* Fiber.join(resolving);
        expect(error.operation).toBe("stat-candidate");
        expect(error.cause).toMatchObject({ reason: { _tag: "TimedOut" } });

        expect(yield* resolver.resolvePath(healthyRoot)).toBe(
          path.join(healthyRoot, "favicon.svg"),
        );
        // The paused folder fails at once and never gets a second thread.
        const again = yield* Effect.flip(resolver.resolvePath(hungRoot));
        expect(again.cause).toMatchObject({ reason: { _tag: "TimedOut" } });
        expect(hungStats).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("forgets a deleted checkout and picks up a re-clone at the same path", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* makeTempDir;
        const gate = WorkspaceIoGate.makeWorkspaceIoGate({ maxInFlight: 2, timeout: "10 seconds" });
        const resolver = yield* ProjectFaviconResolver.make.pipe(
          Effect.provide([WorkspacePaths.layer, T3ProjectFileLoader.layer]),
          Effect.provideService(WorkspaceIoGate.WorkspaceIoGate, gate),
        );
        // A project checkout and a thread worktree are both short-lived roots.
        for (const relativeRoot of ["project", "worktrees/project/feature"]) {
          const root = path.join(parent, relativeRoot);
          yield* writeTextFile(root, "favicon.svg", "<svg>first clone</svg>");
          expect(yield* resolver.resolvePath(root)).toBe(path.join(root, "favicon.svg"));

          yield* fileSystem.remove(root, { recursive: true });
          const gone = yield* Effect.flip(resolver.resolvePath(root));
          expect(ProjectFaviconResolver.isMissingWorkspaceRoot(gone)).toBe(true);
          expect(gate.trackedRoots()).toBe(0);

          yield* writeTextFile(root, "favicon.png", "png");
          expect(yield* resolver.resolvePath(root)).toBe(path.join(root, "favicon.png"));
          expect(gate.trackedRoots()).toBe(0);
        }
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
  });
});
