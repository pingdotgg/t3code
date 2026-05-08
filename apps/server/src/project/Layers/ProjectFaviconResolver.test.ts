import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver.ts";
import { ProjectFaviconResolverLive } from "./ProjectFaviconResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-favicon-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
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

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process.run({
      operation: "ProjectFaviconResolver.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir();
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
        const cwd = yield* makeTempDir();

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("finds nested app favicon metadata from a monorepo root", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "apps/web/index.html", '<link rel="icon" href="/icons/app.svg">');
        yield* writeTextFile(cwd, "apps/web/public/icons/app.svg", "<svg>app</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("apps/web/public/icons/app.svg");
      }),
    );

    it.effect("prefers a root favicon over nested workspace matches", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "favicon.svg", "<svg>root</svg>");
        yield* writeTextFile(cwd, "apps/web/public/favicon.svg", "<svg>nested</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
        expect(resolved).not.toContain("apps/web");
      }),
    );

    it.effect("skips ignored workspace directories when searching nested icons", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".next/public/favicon.svg", "<svg>ignored</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );

    it.effect("skips gitignored root favicons and falls through to nested apps", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "/favicon.svg\n");
        yield* writeTextFile(cwd, "favicon.svg", "<svg>ignored-root</svg>");
        yield* writeTextFile(cwd, "apps/web/public/favicon.svg", "<svg>nested</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("apps/web/public/favicon.svg");
      }),
    );
  });
});
