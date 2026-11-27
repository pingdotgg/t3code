import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

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
    Effect.provide([Layer.fresh(WorkspacePaths.layer), T3ProjectFileLoader.layer]),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
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

    it.effect("looks up a missing workspace root once within the negative cache window", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = path.join(yield* makeTempDir, "deleted-project");
        let rootStats = 0;
        const resolver = yield* makeResolverWithFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (filePath) => {
              if (filePath === cwd) rootStats += 1;
              return fileSystem.stat(filePath);
            },
          }),
        );

        yield* Effect.exit(resolver.resolvePath(cwd));
        yield* Effect.exit(resolver.resolvePath(cwd));
        expect(rootStats).toBe(1);
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
        yield* writeTextFile(
          cwd,
          "index.html",
          `<link rel="icon" href="data:image/png;base64,${"A".repeat(5000)}">
<link rel="icon" href="https://cdn.example.com/icon.svg">
<link rel="icon" href="/missing.svg">
<link rel="icon" href="//cdn.example.com/icon.svg">
<link rel="icon" href="/index.html/icon.svg">
<link rel="icon" href="/a%00b.svg">
<link rel="icon" href="/brand/logo.svg#mark">
<link rel="icon" href="/brand/late.svg">`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");
        yield* writeTextFile(cwd, "public/brand/late.svg", "<svg>late</svg>");
        yield* writeTextFile(cwd, "public/cdn.example.com/icon.svg", "<svg>cdn</svg>");
        yield* writeTextFile(cwd, "web/favicon.png", "flutter");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toBe((yield* Path.Path).join(cwd, "public", "brand", "logo.svg"));

        // A cached icon whose `public` folder became a file falls back instead of failing.
        yield* (yield* FileSystem.FileSystem).remove((yield* Path.Path).join(cwd, "public"), {
          recursive: true,
        });
        yield* writeTextFile(cwd, "public", "not a folder");
        expect(yield* resolver.resolvePath(cwd)).toBe(
          (yield* Path.Path).join(cwd, "web", "favicon.png"),
        );

        const flutterCwd = yield* makeTempDir;
        yield* writeTextFile(flutterCwd, "web/favicon.png", "flutter");
        expect(yield* resolver.resolvePath(flutterCwd)).toBe(
          (yield* Path.Path).join(flutterCwd, "web", "favicon.png"),
        );

        const paddedCwd = yield* makeTempDir;
        yield* writeTextFile(
          paddedCwd,
          "index.html",
          '<link rel="icon" href=" brand/custom.svg ">',
        );
        yield* writeTextFile(paddedCwd, "brand/custom.svg", "<svg>custom</svg>");
        expect(yield* resolver.resolvePath(paddedCwd)).toBe(
          (yield* Path.Path).join(paddedCwd, "brand", "custom.svg"),
        );

        const tokenListCwd = yield* makeTempDir;
        yield* writeTextFile(
          tokenListCwd,
          "index.html",
          `<link rel="apple-touch-icon" href="touch.svg"><link rel="icon's" href="touch.svg"><link rel="Icon\tshortcut" href="brand.svg">`,
        );
        yield* writeTextFile(tokenListCwd, "touch.svg", "<svg>touch</svg>");
        yield* writeTextFile(tokenListCwd, "brand.svg", "<svg>brand</svg>");
        expect(yield* resolver.resolvePath(tokenListCwd)).toBe(
          (yield* Path.Path).join(tokenListCwd, "brand.svg"),
        );

        const unquotedCwd = yield* makeTempDir;
        yield* writeTextFile(
          unquotedCwd,
          "index.html",
          `<link rel=stylesheet data-rel=icon href=app.css><link href=app.css rel=icon/><link rel=icon href={icon} /><link rel=icon data-href=app.css title="href=app.css" href=brand.svg/>`,
        );
        yield* writeTextFile(unquotedCwd, "app.css", "body {}");
        yield* writeTextFile(unquotedCwd, "brand.svg", "<svg>brand</svg>");
        expect(yield* resolver.resolvePath(unquotedCwd)).toBe(
          (yield* Path.Path).join(unquotedCwd, "brand.svg"),
        );

        const quotedValueCwd = yield* makeTempDir;
        yield* writeTextFile(
          quotedValueCwd,
          "index.html",
          `<link rel="icon" title='preview href=app.css < primary' media="(width > 600px)" href="brand.svg">`,
        );
        yield* writeTextFile(quotedValueCwd, "app.css", "body {}");
        yield* writeTextFile(quotedValueCwd, "brand.svg", "<svg>brand</svg>");
        expect(yield* resolver.resolvePath(quotedValueCwd)).toBe(
          (yield* Path.Path).join(quotedValueCwd, "brand.svg"),
        );

        const unquotedQuoteCwd = yield* makeTempDir;
        yield* writeTextFile(
          unquotedQuoteCwd,
          "index.html",
          `<link rel=stylesheet title=O'Reilly><link rel="icon" href="brand.svg"><!-- it's -->`,
        );
        yield* writeTextFile(unquotedQuoteCwd, "brand.svg", "<svg>brand</svg>");
        expect(yield* resolver.resolvePath(unquotedQuoteCwd)).toBe(
          (yield* Path.Path).join(unquotedQuoteCwd, "brand.svg"),
        );

        const encodedCwd = yield* makeTempDir;
        yield* writeTextFile(encodedCwd, "index.html", '<link rel="icon" href="/team%20mark.svg">');
        yield* writeTextFile(encodedCwd, "public/team mark.svg", "<svg>team</svg>");
        expect(yield* resolver.resolvePath(encodedCwd)).toBe(
          (yield* Path.Path).join(encodedCwd, "public", "team mark.svg"),
        );

        for (const [href, filename] of [
          ["/brand/logo.svg&#35;mark", "logo.svg"],
          ["/brand/design&amp;dev.svg&#x3f;v=2", "design&dev.svg"],
          ["/brand/logo%23mark.svg&quest;v=2", "logo#mark.svg"],
          ["/brand/&#128;.svg", "\u20ac.svg"],
          ["/brand/design&amp-dev.svg", "design&-dev.svg"],
          ["/brand/a&copy=b.svg", "a&copy=b.svg"],
          ["/brand/&ampdev.svg", "&ampdev.svg"],
          ["/brand/&apos.svg", "&apos.svg"],
        ] as const) {
          const entityCwd = yield* makeTempDir;
          yield* writeTextFile(entityCwd, "index.html", `<link rel="icon" href="${href}">`);
          yield* writeTextFile(entityCwd, `public/brand/${filename}`, "<svg>brand</svg>");
          expect(yield* resolver.resolvePath(entityCwd), href).toBe(
            (yield* Path.Path).join(entityCwd, "public", "brand", filename),
          );
        }

        const jsxCwd = yield* makeTempDir;
        yield* writeTextFile(
          jsxCwd,
          "app/root.tsx",
          '<link rel="icon" href="/brand/a&amp-b.svg" />',
        );
        yield* writeTextFile(jsxCwd, "public/brand/a&amp-b.svg", "<svg>brand</svg>");
        expect(yield* resolver.resolvePath(jsxCwd)).toBe(
          (yield* Path.Path).join(jsxCwd, "public", "brand", "a&amp-b.svg"),
        );

        const malformedCwd = yield* makeTempDir;
        yield* writeTextFile(malformedCwd, "index.html", '<link rel="icon" href="/100%.svg">');
        yield* writeTextFile(malformedCwd, "public/100%.svg", "<svg>100</svg>");
        expect(yield* resolver.resolvePath(malformedCwd)).toBe(
          (yield* Path.Path).join(malformedCwd, "public", "100%.svg"),
        );
      }),
    );

    it.effect("resolves relative hrefs in src/index.html against src after public and root", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/index.html",
          '<link rel="icon" href="/brand/root.svg"><link rel="icon" type="image/png" href="assets/brand/icon.png">',
        );
        yield* writeTextFile(cwd, "src/brand/root.svg", "<svg>src</svg>");
        yield* writeTextFile(cwd, "src/assets/brand/icon.png", "png");
        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "src", "assets", "brand", "icon.png"),
        );
        yield* writeTextFile(cwd, "public/assets/brand/icon.png", "public");
        yield* resolver.invalidate(cwd);
        expect(yield* resolver.resolvePath(cwd)).toBe(
          path.join(cwd, "public", "assets", "brand", "icon.png"),
        );
      }),
    );

    it.effect("skips source metadata beyond the favicon scan limit", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "index.html",
          `<!-- ${" ".repeat(128 * 1024)} --><link rel="icon" href="/brand/logo.svg">`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
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
      { rel: "icon", href: "https://cdn.example.com/icon.svg" },
      { rel: "icon shortcut", href: "/brand/logo.svg#mark" },
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

    it.effect("skips icon metadata paths outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const cwd = path.join(root, "parent", "workspace");
        yield* writeTextFile(root, "outside.svg", "<svg>two-levels-up</svg>");
        yield* writeTextFile(root, "parent/outside.svg", "<svg>one-level-up</svg>");
        yield* writeTextFile(
          cwd,
          "index.html",
          '<link rel="icon" href="../../outside.svg"><link rel="icon" href="/%2e%2e%2f%2e%2e%2foutside.svg">',
        );
        yield* writeTextFile(cwd, "src/index.html", '<link rel="icon" href="../../outside.svg">');

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );
  });
});
