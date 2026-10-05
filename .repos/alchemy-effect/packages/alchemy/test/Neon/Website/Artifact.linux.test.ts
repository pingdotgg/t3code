import { stageWebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { buildPortableExample } from "./Fixture.ts";

for (const slug of ["nextjs", "vocs"] as const) {
  it.live.skipIf(!process.env.NEON_WEBSITE_LINUX)(
    `${slug} production artifact runs on Linux ARM64 glibc without host dependencies`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const next = slug === "nextjs";
        const artifact = yield* stageWebsiteArtifact(
          yield* buildPortableExample(slug),
        );
        const probe = [
          'import assert from "node:assert/strict";',
          'import fs from "node:fs";',
          'import path from "node:path";',
          'import { createRequire } from "node:module";',
          "try {",
          'assert.equal(process.platform, "linux"); assert.equal(process.arch, "arm64");',
          "assert.ok(process.report.getReport().header.glibcVersionRuntime);",
          ...(next
            ? [
                'const entry = [...fs.globSync("files/**/serve-neon.mjs")][0]; fs.writeFileSync(path.join(path.dirname(entry), "public/pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));',
              ]
            : []),
          'const { default: handler } = await import("./index.mjs");',
          ...(next
            ? [
                'const require = createRequire(path.join(process.cwd(), "package.json")); const sharp = createRequire(require.resolve("next/package.json"))("sharp"); assert.ok(sharp.versions.vips);',
              ]
            : []),
          'const request = (url, method = "GET", headers) => handler.fetch(new Request("http://localhost" + url, { method, headers }));',
          'const home = await request("/"); assert.equal(home.status, 200); const html = await home.text(); assert.match(html, /Neon/);',
          'for (const method of ["GET", "HEAD"]) { const res = await request("/example.json", method); assert.equal(res.status, 200); const text = await res.text(); if (method === "HEAD") assert.equal(text, ""); else assert.match(text, /framework/); }',
          'const assets = [...html.matchAll(/(?:src|href)="([^" ]+\\.(?:js|css)(?:\\?[^" ]*)?)"/g)].map(m => m[1]).filter(url => url.startsWith("/")); assert.ok(assets.length > 0);',
          "for (const url of assets.slice(0, 3)) { const res = await request(url); assert.equal(res.status, 200, url); assert.ok((await res.arrayBuffer()).byteLength > 0); }",
          ...(next
            ? [
                'const image = await request("/_next/image?url=%2Fpixel.png&w=64&q=75", "GET", { accept: "image/webp" }); assert.equal(image.status, 200, await (image.status === 200 ? Promise.resolve("") : image.text())); assert.match(image.headers.get("content-type"), /^image\\/webp/); assert.ok((await image.arrayBuffer()).byteLength > 0);',
                'const stream = await request("/api/stream"); assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type"), /text\\/event-stream/); const reader = stream.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /data: first/); let rest = ""; for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); } assert.match(rest, /data: second/);',
              ]
            : [
                'const page = await request("/guide"); assert.equal(page.status, 200); assert.match(await page.text(), /Guide/);',
              ]),
          'console.log("NEON_LINUX_ARTIFACT_OK"); process.exit(0);',
          "} catch (error) { console.error(error); process.exit(1); }",
        ].join("\n");
        yield* fs.writeFileString(
          path.join(artifact.directory, "probe.mjs"),
          probe,
        );
        const proc = yield* ChildProcess.make("docker", [
          "run",
          "--rm",
          "--network=none",
          "--memory=1g",
          "--memory-swap=1g",
          "--cpus=2",
          "--platform=linux/arm64",
          "--mount",
          `type=bind,source=${artifact.directory},target=/app`,
          "--workdir",
          "/app",
          "--env",
          "NODE_ENV=production",
          "node:24-bookworm-slim",
          "node",
          "probe.mjs",
        ]);
        const [code, stdout, stderr] = yield* Effect.all(
          [
            proc.exitCode,
            proc.stdout.pipe(Stream.decodeText, Stream.mkString),
            proc.stderr.pipe(Stream.decodeText, Stream.mkString),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("45 seconds"));
        expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect({
          completed: stdout.includes("NEON_LINUX_ARTIFACT_OK"),
          stdout,
          stderr,
        }).toMatchObject({ completed: true });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    {
      tags: ["provider:neon", "provider:neon:website", "local"],
      timeout: 120_000,
    },
  );
}
