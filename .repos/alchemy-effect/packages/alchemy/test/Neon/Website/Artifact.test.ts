import {
  packageWebsiteArtifact,
  stageWebsiteArtifact,
} from "@/Neon/Website/Artifact.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { unzipSync } from "fflate";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "neon-website-test-",
  });
  const dist = path.join(root, "dist");
  yield* fs.makeDirectory(dist);
  yield* fs.writeFileString(path.join(dist, "index.html"), "<h1>Neon</h1>");
  return { fs, path, root, dist };
});

it.effect(
  "static archives are deterministic and omit env and source maps",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, dist } = yield* fixture;
      yield* fs.writeFileString(
        path.join(dist, ".env.production"),
        "TOKEN=do-not-package",
      );
      yield* fs.writeFileString(path.join(dist, "app.js.map"), "source-secret");
      const props = {
        root,
        distDir: dist,
        static: { notFoundHandling: "spa" as const },
      };
      const first = yield* packageWebsiteArtifact(props);
      const second = yield* packageWebsiteArtifact(props);
      expect(first.hash).toBe(second.hash);
      const files = yield* Effect.sync(() => unzipSync(first.archive));
      expect(files["index.mjs"]).toBeDefined();
      expect(
        Object.keys(files).some(
          (name) => name.includes(".env") || name.endsWith(".map"),
        ),
      ).toBe(false);
      const source = yield* Effect.sync(() =>
        new TextDecoder().decode(files["index.mjs"]),
      );
      expect(source).toContain("export default");
      expect(source).not.toContain(".listen(");
      yield* fs.writeFileString(
        path.join(dist, "index.html"),
        "<h1>Updated</h1>",
      );
      expect((yield* packageWebsiteArtifact(props)).hash).not.toBe(first.hash);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
);

for (const kind of [
  "escape",
  "native",
  "executable",
  "secret-alias",
  "cycle",
  "error-page",
] as const) {
  it.effect(
    `rejects unsafe ${kind} output`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, dist } = yield* fixture;
        if (kind === "escape") {
          yield* fs.writeFileString(path.join(root, "secret.txt"), "private");
          yield* fs.symlink("../secret.txt", path.join(dist, "leak.txt"));
        } else if (kind === "native")
          yield* fs.writeFileString(path.join(dist, "addon.node"), "native");
        else if (kind === "executable")
          yield* fs.writeFile(
            path.join(dist, "binary"),
            new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
          );
        else if (kind === "secret-alias") {
          yield* fs.writeFileString(path.join(dist, ".env"), "SECRET=hidden");
          yield* fs.symlink(".env", path.join(dist, "public.txt"));
        } else if (kind === "cycle")
          yield* fs.symlink(".", path.join(dist, "cycle"));
        const result = yield* stageWebsiteArtifact({
          root,
          distDir: dist,
          static: {
            errorPage: kind === "error-page" ? "../secret.txt" : undefined,
          },
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("WebsiteArtifactError");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
  );
}

for (const sensitive of [
  ".env.production",
  ".alchemy/state file.json",
  "private.pem",
])
  for (const alias of [false, true])
    it.effect(
      `rejects traced ${JSON.stringify(sensitive)}${alias ? " through a symlink" : ""} with a sanitized filename`,
      () =>
        Effect.gen(function* () {
          const { fs, path, root, dist } = yield* fixture;
          const secret = path.join(root, sensitive);
          yield* fs.makeDirectory(path.dirname(secret), { recursive: true });
          yield* fs.writeFileString(secret, "fixture-secret-do-not-log");
          const dependency = alias ? "runtime-data.txt" : sensitive;
          if (alias) yield* fs.symlink(secret, path.join(root, dependency));
          const serverEntry = path.join(dist, "serve.mjs");
          yield* fs.writeFileString(
            serverEntry,
            `import { readFileSync } from "node:fs";
const value = readFileSync(new URL(${JSON.stringify(`../${dependency}`)}, import.meta.url), "utf8");
export default { fetch: () => new Response(value) };`,
          );
          const result = yield* stageWebsiteArtifact({
            root,
            distDir: dist,
            serverEntry,
          }).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("WebsiteArtifactError");
            expect(result.failure.message).toBe(
              `A traced dependency selects a sensitive file: ${sensitive.replace(/[^a-zA-Z0-9_./@+-]/g, "_")}`,
            );
            expect(result.failure.message).not.toContain(root);
            expect(result.failure.message).not.toContain(
              "fixture-secret-do-not-log",
            );
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
    );

it.effect(
  "traces referenced source data without selecting neighboring state or secrets",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, dist } = yield* fixture;
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.makeDirectory(path.join(root, ".alchemy"));
      yield* fs.writeFileString(path.join(root, "src/guide.mdx"), "# Guide");
      yield* fs.writeFileString(path.join(root, ".env"), "fixture-secret");
      yield* fs.writeFileString(path.join(root, "private.key"), "fixture-key");
      yield* fs.writeFileString(
        path.join(root, ".alchemy/state.json"),
        '{"private":"fixture-state"}',
      );
      const serverEntry = path.join(dist, "serve.mjs");
      yield* fs.writeFileString(
        serverEntry,
        'import { readFileSync } from "node:fs"; const guide = readFileSync(new URL("../src/guide.mdx", import.meta.url), "utf8"); export default { fetch: () => new Response(guide) };',
      );
      const props = { root, distDir: dist, serverEntry };
      const first = yield* packageWebsiteArtifact(props);
      const archive = yield* Effect.sync(() => unzipSync(first.archive));
      expect(Object.keys(archive).sort()).toEqual([
        "files/dist/index.html",
        "files/dist/serve.mjs",
        "files/src/guide.mdx",
        "index.mjs",
      ]);
      yield* fs.writeFileString(
        path.join(root, "src/guide.mdx"),
        "# Updated guide",
      );
      expect((yield* packageWebsiteArtifact(props)).hash).not.toBe(first.hash);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
);

for (const alias of [false, true])
  it.effect(
    `rejects a traced workspace escape${alias ? " through a symlink" : ""}`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, dist } = yield* fixture;
        const outside = yield* fs.makeTempDirectoryScoped();
        const dependency = path.join(outside, "runtime-data.txt");
        yield* fs.writeFileString(dependency, "outside-workspace");
        const selected = alias
          ? path.join(root, "runtime-data.txt")
          : dependency;
        if (alias) yield* fs.symlink(dependency, selected);
        const serverEntry = path.join(dist, "serve.mjs");
        yield* fs.writeFileString(
          serverEntry,
          `import { readFileSync } from "node:fs"; const value = readFileSync(${JSON.stringify(selected)}, "utf8"); export default { fetch: () => new Response(value) };`,
        );
        const result = yield* stageWebsiteArtifact({
          root,
          distDir: dist,
          serverEntry,
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("WebsiteArtifactError");
          expect(result.failure.message).toBe(
            "A traced dependency escapes the application workspace.",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
  );

for (const mode of ["import", "require"] as const)
  it.effect(
    `resolves pnpm ${mode} aliases without copying untraced dependencies`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, dist } = yield* fixture;
        const store = path.join(
          root,
          "node_modules",
          ".pnpm",
          "answer@1",
          "node_modules",
          "answer",
        );
        yield* fs.makeDirectory(store, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          '{"type":"module"}',
        );
        yield* fs.writeFileString(
          path.join(store, "package.json"),
          '{"name":"answer","type":"module","exports":"./index.js"}',
        );
        yield* fs.writeFileString(
          path.join(store, "index.js"),
          "export const answer = 42;",
        );
        yield* fs.writeFileString(path.join(store, "unused.txt"), "not-traced");
        yield* fs.symlink(
          ".pnpm/answer@1/node_modules/answer",
          path.join(root, "node_modules", "answer"),
        );
        const other = path.join(
          root,
          "node_modules/.pnpm/answer@2/node_modules/answer",
        );
        yield* fs.makeDirectory(other, { recursive: true });
        yield* fs.writeFileString(
          path.join(other, "package.json"),
          '{"name":"answer","type":"module","exports":"./index.js"}',
        );
        yield* fs.writeFileString(
          path.join(other, "index.js"),
          "export const answer = 99;",
        );
        yield* fs.makeDirectory(
          path.join(root, "node_modules/.pnpm/node_modules"),
        );
        yield* fs.symlink(
          "../answer@2/node_modules/answer",
          path.join(root, "node_modules/.pnpm/node_modules/answer"),
        );
        yield* fs.writeFileString(
          path.join(dist, "other.mjs"),
          'import "../node_modules/.pnpm/node_modules/answer/index.js";',
        );
        const serverEntry = path.join(dist, "serve-neon.mjs");
        yield* fs.writeFileString(
          serverEntry,
          (mode === "import"
            ? 'import { answer } from "answer";'
            : 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const { answer } = require("answer");') +
            " export default { fetch() { return new Response(String(answer)); } };",
        );
        const props = { root, distDir: dist, serverEntry };
        const first = yield* packageWebsiteArtifact(props);
        const files = yield* Effect.sync(() => unzipSync(first.archive));
        expect(
          Object.keys(files).some((name) =>
            name.endsWith("node_modules/answer/index.js"),
          ),
        ).toBe(true);
        expect(
          Object.keys(files).some((name) => name.endsWith("unused.txt")),
        ).toBe(false);
        const staged = yield* stageWebsiteArtifact(props);
        const proc = yield* ChildProcess.make("node", [
          "--input-type=module",
          "-e",
          `const {default: handler} = await import(${JSON.stringify(path.join(staged.directory, "index.mjs"))}); console.log(await handler.fetch(new Request("http://localhost/")).text());`,
        ]);
        const [code, stdout, stderr] = yield* Effect.all(
          [
            proc.exitCode,
            proc.stdout.pipe(Stream.decodeText, Stream.mkString),
            proc.stderr.pipe(Stream.decodeText, Stream.mkString),
          ],
          { concurrency: "unbounded" },
        );
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout.trim()).toBe("42");
        yield* fs.writeFileString(
          path.join(store, "index.js"),
          "export const answer = 43;",
        );
        expect((yield* packageWebsiteArtifact(props)).hash).not.toBe(
          first.hash,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
  );

const elf = (machine = 183) => {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes[16] = 3;
  bytes[18] = machine;
  return bytes;
};

for (const machine of [183, 62])
  it.effect(
    `validates ELF target architecture ${machine}`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, dist } = yield* fixture;
        yield* fs.writeFile(
          path.join(dist, "addon.node"),
          yield* Effect.sync(() => elf(machine)),
        );
        const result = yield* stageWebsiteArtifact({
          root,
          distDir: dist,
          static: {},
        }).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(machine === 183);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
  );

it.effect(
  "Sharp metadata-only traces do not materialize native packages",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, dist } = yield* fixture;
      const sharp = path.join(root, "node_modules/sharp");
      yield* fs.makeDirectory(sharp, { recursive: true });
      yield* fs.writeFileString(
        path.join(sharp, "package.json"),
        JSON.stringify({ name: "sharp", version: "0.35.4" }),
      );
      const serverEntry = path.join(dist, "serve.mjs");
      yield* fs.writeFileString(
        serverEntry,
        'import manifest from "sharp/package.json" with { type: "json" }; export default { fetch: () => new Response(manifest.version) };',
      );
      const artifact = yield* stageWebsiteArtifact({
        root,
        distDir: dist,
        serverEntry,
      });
      expect(
        yield* fs.exists(
          path.join(
            artifact.directory,
            "files/node_modules/sharp/package.json",
          ),
        ),
      ).toBe(true);
      expect(
        yield* fs.exists(
          path.join(artifact.directory, "files/node_modules/@img"),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
);

// Minimal ustar fixtures exercise the registry boundary without downloading packages.
const tarball = (files: [string, Uint8Array, string?][]) => {
  const blocks: Buffer[] = [];
  for (const [name, content, type = "0"] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write("ustar\0", 257);
    const checksum = header.reduce(
      (sum: number, byte: number) => sum + byte,
      0,
    );
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(
      header,
      Buffer.from(content),
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};

for (const scenario of [
  "valid",
  "integrity",
  "identity",
  "origin",
  "traversal",
  "symlink",
  "architecture",
  "musl",
] as const)
  it.effect(
    `Sharp platform replacement verifies ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, dist } = yield* fixture;
        const sharp = path.join(root, "node_modules/sharp");
        yield* fs.makeDirectory(sharp, { recursive: true });
        yield* fs.writeFileString(
          path.join(sharp, "package.json"),
          JSON.stringify({
            name: "sharp",
            version: "0.34.5",
            main: "index.js",
            optionalDependencies: {
              "@img/sharp-linux-arm64": "0.34.5",
              "@img/sharp-libvips-linux-arm64": "1.2.4",
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(sharp, "index.js"),
          "module.exports = 42;",
        );
        const serverEntry = path.join(dist, "serve.mjs");
        yield* fs.writeFileString(
          serverEntry,
          'import sharp from "sharp"; export default { fetch: () => new Response(String(sharp)) };',
        );
        const requested: string[] = [];
        const fetch = ((input: string | URL | Request) =>
          Effect.runPromise(
            Effect.sync(() => {
              const url = String(input);
              requested.push(url);
              const name = url.includes("libvips")
                ? "@img/sharp-libvips-linux-arm64"
                : "@img/sharp-linux-arm64";
              const version = name.includes("libvips") ? "1.2.4" : "0.34.5";
              const manifest = {
                name,
                version,
                os: ["linux"],
                cpu: ["arm64"],
                libc: [scenario === "musl" ? "musl" : "glibc"],
              };
              const binary = name.includes("libvips")
                ? "lib/libvips.so.42"
                : "lib/sharp-linux-arm64.node";
              const archive = tarball([
                ["package/package.json", Buffer.from(JSON.stringify(manifest))],
                [
                  scenario === "traversal"
                    ? "package/../escape"
                    : `package/${binary}`,
                  elf(scenario === "architecture" ? 62 : 183),
                  scenario === "symlink" ? "2" : "0",
                ],
              ]);
              if (url.endsWith(".tgz")) return new Response(archive);
              return Response.json({
                ...manifest,
                version: scenario === "identity" ? "99.0.0" : version,
                dist: {
                  integrity: `sha512-${createHash("sha512")
                    .update(scenario === "integrity" ? "wrong" : archive)
                    .digest("base64")}`,
                  tarball: `${scenario === "origin" ? "https://untrusted.invalid" : "https://registry.npmjs.org"}/${name}/-/${name.split("/")[1]}-${version}.tgz`,
                },
              });
            }),
          )) as typeof globalThis.fetch;
        const result = yield* stageWebsiteArtifact({
          root,
          distDir: dist,
          serverEntry,
        }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.result,
        );
        expect(Result.isSuccess(result)).toBe(scenario === "valid");
        expect(requested.length).toBeGreaterThan(0);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("WebsiteArtifactError");
        if (Result.isSuccess(result)) {
          const packageFile = path.join(
            result.success.directory,
            "files/node_modules/@img/sharp-linux-arm64/package.json",
          );
          expect(
            JSON.parse(yield* fs.readFileString(packageFile)).version,
          ).toBe("0.34.5");
          expect(
            JSON.parse(
              yield* fs.readFileString(path.join(sharp, "package.json")),
            ).version,
          ).toBe("0.34.5");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
  );
