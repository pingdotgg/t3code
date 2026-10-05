import { make as makeVite } from "@alchemy.run/frontend-frameworks/vite";
import { make as makeNext } from "@alchemy.run/frontend-frameworks/nextjs/node";
import { make as makeVinext } from "@alchemy.run/frontend-frameworks/vinext/node";
import { createComputeArchive } from "@/Prisma/ComputeArchive";
import { stageWebsiteArtifact } from "@/Prisma/Website/Artifact";
import { findAvailablePort } from "@/Util/Node";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

const services = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

const fixture = Effect.fn(function* (name: "vite" | "next") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtures = yield* path.fromFileUrl(
    new URL("./fixtures/website-artifact/", import.meta.url),
  );
  const root = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: fixtures, prefix: "build-" }),
    (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  yield* fs.copy(path.join(fixtures, name), root);
  yield* fs.writeFileString(
    path.join(root, ".env.private"),
    "MUST_NOT_SHIP=secret",
  );
  yield* fs.writeFileString(
    path.join(root, "unrelated-private-file.txt"),
    "not a runtime dependency",
  );
  return root;
});

const extract = Effect.fn(function* (archive: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "prisma-website-extracted-",
  });
  const archivePath = path.join(root, "artifact.tar.gz");
  yield* fs.writeFile(archivePath, archive);
  const spawner = yield* ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("tar", ["-xzf", archivePath, "-C", root], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  expect(yield* child.exitCode).toBe(0);
  const manifest = yield* fs.readFileString(
    path.join(root, "compute.manifest.json"),
  );
  expect(JSON.parse(manifest).entrypoint).toBe("bundle/server.mjs");
  return path.join(root, "bundle");
});

const serve = Effect.fn(function* (directory: string) {
  const port = yield* findAvailablePort();
  const runtime = yield* Effect.sync(() => process.execPath);
  const spawner = yield* ChildProcessSpawner;
  yield* spawner.spawn(
    ChildProcess.make(runtime, ["server.mjs"], {
      cwd: directory,
      env: { PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      killSignal: "SIGKILL",
    }),
  );
  const url = `http://127.0.0.1:${port}`;
  yield* HttpClient.get(`${url}/health`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new Error(`HTTP ${response.status}`)),
    ),
    Effect.timeout("1 second"),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 10 }),
  );
  return url;
});

const listFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(root, { recursive: true });
});

describe.sequential(
  "Prisma Website artifacts",
  { tags: ["provider:prisma", "provider:prisma:website", "local"] },
  () => {
    it.effect(
      "ignores dangling optional-package resolution links while retaining the runtime fallback",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("vite");
            const dist = path.join(root, "dist");
            const modules = path.join(root, "node_modules");
            yield* fs.makeDirectory(dist);
            yield* fs.makeDirectory(modules);
            yield* fs.symlink(
              path.join(root, "missing-optional-runtime"),
              path.join(modules, "optional-runtime"),
            );
            const entry = path.join(dist, "server.cjs");
            yield* fs.writeFileString(
              entry,
              'try { module.exports = require("optional-runtime"); } catch { module.exports = require("./fallback.cjs"); }',
            );
            yield* fs.writeFileString(
              path.join(dist, "fallback.cjs"),
              'module.exports = "fallback";',
            );
            const staged = yield* stageWebsiteArtifact({
              root,
              distDir: dist,
              serverEntry: entry,
            });
            const files = yield* listFiles(staged.directory);
            expect(files.some((file) => file.endsWith("fallback.cjs"))).toBe(
              true,
            );
            expect(
              files.some((file) => file.includes("optional-runtime")),
            ).toBe(false);
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["unit"] },
    );

    it.effect(
      "rejects a dangling symlink in the build output",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("vite");
            const dist = path.join(root, "dist");
            yield* fs.makeDirectory(dist);
            yield* fs.symlink(
              path.join(root, "missing-build-asset"),
              path.join(dist, "required-asset"),
            );
            const error = yield* stageWebsiteArtifact({
              root,
              distDir: dist,
              static: {},
            }).pipe(Effect.flip);
            expect(String(error)).toContain("required-asset");
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["unit"] },
    );

    it.effect(
      "rejects output symlinks that would package the source tree",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("vite");
            const dist = path.join(root, "dist");
            yield* fs.makeDirectory(dist);
            yield* fs.symlink(root, path.join(dist, "source"));
            const error = yield* stageWebsiteArtifact({
              root,
              distDir: dist,
              static: {},
            }).pipe(Effect.flip);
            expect(String(error)).toContain(
              "symlink escapes its selected directory",
            );
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["unit"] },
    );

    it.live(
      "builds Vite and serves the extracted artifact without the source tree",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("vite");
            const framework = yield* makeVite({
              root,
              target: "@alchemy.run/frontend-frameworks/vite/node",
            });
            const built = yield* framework.build({ root });
            const dist = built.distDirectory!;
            yield* fs.writeFileString(
              path.join(dist, ".env"),
              "BUILD_SECRET=hidden",
            );
            const staged = yield* stageWebsiteArtifact({
              root,
              distDir: dist,
              serverEntry: path.join(dist, built.serverModules![0]!.name),
            });
            const archive = yield* createComputeArchive(staged);
            const extracted = yield* extract(archive);
            const files = yield* listFiles(extracted);
            expect(files.some((file) => file.endsWith(".env"))).toBe(false);
            expect(
              files.some((file) => file.includes("unrelated-private-file")),
            ).toBe(false);
            yield* fs.remove(root, { recursive: true });
            const url = yield* serve(extracted);
            const html = yield* HttpClient.get(url).pipe(
              Effect.flatMap((response) => response.text),
            );
            expect(html).toContain("Website artifact Vite build");
            const asset = html.match(/src="([^"]+\.js)"/)?.[1];
            expect(asset).toBeDefined();
            expect(
              yield* HttpClient.get(`${url}${asset}`).pipe(
                Effect.flatMap((response) => response.text),
              ),
            ).toContain("built-by-real-vite");
            expect((yield* HttpClient.get(`${url}/deep/link`)).status).toBe(
              200,
            );
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["provider:prisma:compute"], timeout: 90_000 },
    );

    it.live(
      "packages static output without copying source or installed dependencies",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("vite");
            const framework = yield* makeVite({
              root,
              target: "@alchemy.run/frontend-frameworks/vite/node",
            });
            const built = yield* framework.build({ root });
            yield* fs.writeFileString(
              path.join(built.distDirectory!, "missing.html"),
              "Artifact not found",
            );
            const staged = yield* stageWebsiteArtifact({
              root,
              distDir: built.distDirectory!,
              static: {
                notFoundHandling: "404-page",
                errorPage: "missing.html",
              },
            });
            const extracted = yield* extract(
              yield* createComputeArchive(staged),
            );
            expect(
              (yield* listFiles(extracted)).some((file) =>
                file.includes("node_modules"),
              ),
            ).toBe(false);
            yield* fs.remove(root, { recursive: true });
            const url = yield* serve(extracted);
            const missing = yield* HttpClient.get(`${url}/missing`);
            expect(missing.status).toBe(404);
            expect(yield* missing.text).toBe("Artifact not found");
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["provider:prisma:compute"], timeout: 90_000 },
    );

    it.live(
      "builds vinext and preserves vendored package paths in the extracted artifact",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const root = yield* path.fromFileUrl(
              new URL(
                "../../../../examples/prisma-website-vinext/",
                import.meta.url,
              ),
            );
            const framework = yield* makeVinext({ root });
            const built = yield* framework.build({ root });
            const staged = yield* stageWebsiteArtifact({
              root,
              distDir: built.distDirectory,
              serverEntry: path.join(
                built.distDirectory,
                built.serverModules[0]!.name,
              ),
            });
            const extracted = yield* extract(
              yield* createComputeArchive(staged),
            );
            const files = yield* listFiles(extracted);
            expect(
              files.some(
                (file) =>
                  file.includes("/deps/.pnpm/pathslash@") &&
                  file.endsWith("/dist/index.js"),
              ),
            ).toBe(true);
            const url = yield* serve(extracted);
            const home = yield* HttpClient.get(url);
            expect(home.status).toBe(200);
            expect(yield* home.text).toContain("Hello from vinext on Prisma!");
            const asset = yield* HttpClient.get(`${url}/example.json`);
            expect(yield* asset.json).toEqual({
              framework: "vinext",
              greeting: "Hello from vinext on Prisma!",
            });
            const api = yield* HttpClient.get(`${url}/api/hello?name=artifact`);
            expect(yield* api.json).toEqual({
              name: "artifact",
              greeting: "hello",
            });
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["provider:prisma:compute"], timeout: 120_000 },
    );

    it.live(
      "builds Next.js and traces config, runtime packages, SSR, and public assets",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fixture("next");
            const framework = yield* makeNext({ root });
            const built = yield* framework.build({ root });
            const staged = yield* stageWebsiteArtifact({
              root,
              distDir: built.distDirectory!,
              serverEntry: path.join(root, built.serverModules![0]!.name),
              layout: "next",
            });
            const extracted = yield* extract(
              yield* createComputeArchive(staged),
            );
            const files = yield* listFiles(extracted);
            expect(files.some((file) => file.endsWith("site-config.mjs"))).toBe(
              true,
            );
            expect(files.some((file) => file.endsWith(".next/BUILD_ID"))).toBe(
              true,
            );
            expect(files.some((file) => file.includes(".next/cache/"))).toBe(
              false,
            );
            expect(
              files.some((file) => file.includes("unrelated-private-file")),
            ).toBe(false);
            expect(files.some((file) => file.endsWith(".env.private"))).toBe(
              false,
            );
            yield* fs.remove(root, { recursive: true });
            const url = yield* serve(extracted);
            expect(
              yield* HttpClient.get(url).pipe(
                Effect.flatMap((response) => response.text),
              ),
            ).toContain("Next artifact config dependency");
            expect(
              yield* HttpClient.get(`${url}/artifact.txt`).pipe(
                Effect.flatMap((response) => response.text),
              ),
            ).toBe("Next public artifact\n");
          }),
        ).pipe(Effect.provide(services)),
      { tags: ["provider:prisma:compute"], timeout: 120_000 },
    );
  },
);
