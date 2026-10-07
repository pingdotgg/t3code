import * as Command from "@/Command/index.ts";
import { providers } from "@/Neon/Providers.ts";
import { stageWebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import * as Test from "@/Test/Alchemy.ts";
import { Server } from "@/Website/Server.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { exampleRoot } from "./Fixture.ts";
import { frameworks } from "./Frameworks.ts";

const { test } = Test.make({ providers: providers() });

describe.sequential(
  "Neon Website production Fetch artifacts",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    for (const { slug, name } of frameworks) {
      // Production builds spawn multi-GiB build children (nuxt/vocs ~3 GiB)
      // that cannot share a 4 GiB budget with a long-lived suite process.
      test.provider.skipIf(!!process.env.FAST)(
        slug,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const path = yield* Path.Path;
            const root = yield* exampleRoot(slug);
            const framework = slug === "foldkit" ? "vite" : slug;
            const target = `@alchemy.run/frontend-frameworks/${framework}/neon`;
            const build = yield* stack.deploy(
              Effect.gen(function* () {
                return yield* slug === "static"
                  ? Command.Build("Build", {
                      cwd: root,
                      command: "bun run build",
                      outdir: "dist",
                      memo: false,
                    }).pipe(
                      Effect.map((build) => ({
                        distDir: build.outdir,
                        serverEntry: undefined,
                      })),
                    )
                  : Server("Build", {
                      root,
                      framework:
                        slug === "nextjs" || slug === "vocs"
                          ? target
                          : `@alchemy.run/frontend-frameworks/${framework}`,
                      target,
                      memo: false,
                      env: { GREETING: `Hello from ${name} on Neon!` },
                      options:
                        slug === "astro" ? { astro: { output: "server" } } : {},
                    });
              }),
            );
            expect(build.distDir).toBeDefined();
            const artifact = yield* stageWebsiteArtifact({
              root,
              distDir: build.distDir!,
              serverEntry: build.serverEntry,
              static: slug === "static" ? {} : undefined,
              layout: slug === "nextjs" ? "next" : "output",
            });
            const proc = yield* ChildProcess.make("node", [
              "--input-type=module",
              "-e",
              [
                `const {default: handler} = await import(${JSON.stringify(path.join(artifact.directory, "index.mjs"))});`,
                'for (const [method, pathname] of [["GET", "/"], ["GET", "/example.json"], ["HEAD", "/example.json"]]) {',
                'const response = await handler.fetch(new Request("http://localhost" + pathname, { method }));',
                "const body = await response.text();",
                'if (response.status !== 200 || (method === "HEAD" && body !== "") || (pathname === "/" && !body.includes("Neon"))) { throw new Error(method + " " + pathname + " returned " + response.status + ": " + body.slice(0, 300)); }',
                "}",
                ...(slug === "sveltekit"
                  ? [
                      'for (const method of ["GET", "HEAD"]) {',
                      'const response = await handler.fetch(new Request("http://localhost/about", { method }));',
                      'const body = await response.text(); if (response.status !== 200 || (method === "HEAD" ? body !== "" : !body.includes("prerendered"))) throw new Error(method + " /about returned " + response.status + ": " + body);',
                      "}",
                    ]
                  : []),
                'console.log("NEON_FETCH_ARTIFACT_OK"); process.exit(0);',
              ].join("\n"),
            ]);
            const [code, stdout, stderr] = yield* Effect.all(
              [
                proc.exitCode,
                proc.stdout.pipe(Stream.decodeText, Stream.mkString),
                proc.stderr.pipe(Stream.decodeText, Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeout("30 seconds"));
            expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
              code: 0,
              stderr: "",
            });
            expect(stdout).toContain("NEON_FETCH_ARTIFACT_OK");
            yield* stack.destroy();
          }).pipe(Effect.scoped),
        { timeout: 120_000 },
      );
    }
  },
);
