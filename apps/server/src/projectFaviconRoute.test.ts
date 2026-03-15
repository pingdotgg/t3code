import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { resolveProjectFaviconRoute } from "./projectFaviconRoute";

const layer = it.layer(NodeServices.layer);

const makeProjectDir = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeProjectFile = (projectDir: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(projectDir, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
    return filePath;
  });

layer("resolveProjectFaviconRoute", (it) => {
  it.effect("returns 400 when cwd is missing", () =>
    Effect.gen(function* () {
      const response = yield* resolveProjectFaviconRoute(
        new URL("/api/project-favicon", "http://127.0.0.1"),
      );
      assert.deepEqual(response, {
        kind: "body",
        statusCode: 400,
        body: "Missing cwd parameter",
        contentType: "text/plain",
      });
    }),
  );

  it.effect("serves a well-known favicon file from the project root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const projectDir = yield* makeProjectDir("t3code-favicon-route-root-");
      yield* writeProjectFile(projectDir, "favicon.svg", "<svg>favicon</svg>");

      const result = yield* resolveProjectFaviconRoute(
        new URL(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`, "http://127.0.0.1"),
      );
      assert.deepEqual(result, {
        kind: "file",
        filePath: path.join(projectDir, "favicon.svg"),
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=3600",
      });
    }),
  );

  it.effect("resolves icon href from source files when no well-known favicon exists", () =>
    Effect.gen(function* () {
      const projectDir = yield* makeProjectDir("t3code-favicon-route-source-");
      const iconPath = yield* writeProjectFile(projectDir, "public/brand/logo.svg", "<svg>brand</svg>");
      yield* writeProjectFile(projectDir, "index.html", '<link rel="icon" href="/brand/logo.svg">');

      const result = yield* resolveProjectFaviconRoute(
        new URL(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`, "http://127.0.0.1"),
      );
      assert.deepEqual(result, {
        kind: "file",
        filePath: iconPath,
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=3600",
      });
    }),
  );

  it.effect("resolves icon link when href appears before rel in HTML", () =>
    Effect.gen(function* () {
      const projectDir = yield* makeProjectDir("t3code-favicon-route-html-order-");
      const iconPath = yield* writeProjectFile(
        projectDir,
        "public/brand/logo.svg",
        "<svg>brand-html-order</svg>",
      );
      yield* writeProjectFile(projectDir, "index.html", '<link href="/brand/logo.svg" rel="icon">');

      const result = yield* resolveProjectFaviconRoute(
        new URL(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`, "http://127.0.0.1"),
      );
      assert.deepEqual(result, {
        kind: "file",
        filePath: iconPath,
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=3600",
      });
    }),
  );

  it.effect("resolves object-style icon metadata when href appears before rel", () =>
    Effect.gen(function* () {
      const projectDir = yield* makeProjectDir("t3code-favicon-route-obj-order-");
      const iconPath = yield* writeProjectFile(projectDir, "public/brand/obj.svg", "<svg>brand-obj-order</svg>");
      yield* writeProjectFile(
        projectDir,
        "src/root.tsx",
        'const links = [{ href: "/brand/obj.svg", rel: "icon" }];',
      );

      const result = yield* resolveProjectFaviconRoute(
        new URL(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`, "http://127.0.0.1"),
      );
      assert.deepEqual(result, {
        kind: "file",
        filePath: iconPath,
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=3600",
      });
    }),
  );

  it.effect("serves a fallback favicon when no icon exists", () =>
    Effect.gen(function* () {
      const projectDir = yield* makeProjectDir("t3code-favicon-route-fallback-");
      const result = yield* resolveProjectFaviconRoute(
        new URL(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`, "http://127.0.0.1"),
      );
      assert.deepEqual(result, {
        kind: "body",
        statusCode: 200,
        body: result?.kind === "body" ? result.body : "",
        contentType: "image/svg+xml",
        cacheControl: "public, max-age=3600",
      });
      assert.ok(result?.kind === "body");
      if (result?.kind === "body") {
        assert.ok(result.body.includes('data-fallback="project-favicon"'));
      }
    }),
  );
});
