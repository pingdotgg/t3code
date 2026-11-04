import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// The build output of a `Website.Vite` Worker, mirroring
// `@cloudflare/vite-plugin`'s `explicit-resource-management` and
// `prerendering` playgrounds, deployed and under `alchemy dev`.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const explicitResourceManagementFixtureDir = pathe.resolve(
  import.meta.dirname,
  "vite-explicit-resource-management-fixture",
);
const prerenderingFixtureDir = pathe.resolve(import.meta.dirname, "vite-prerendering-fixture");

type Mode = "live" | "dev";

// The Worker's built chunks, concatenated.
const readWorkerOutput = (rootDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = pathe.join(rootDir, "dist/ssr");
    const files = (yield* fs.readDirectory(directory, { recursive: true })).filter((file) =>
      /\.m?js$/.test(file),
    );
    const sources = yield* Effect.forEach(files, (file) =>
      fs.readFileString(pathe.join(directory, file)),
    );
    return sources.join("\n");
  });

const expectText = (url: string, expected: string, status = 200) =>
  expectResponse(url, (res) =>
    res.status === status && res.body === expected
      ? undefined
      : `${res.status} ${JSON.stringify(res.body.slice(0, 300))}, expected ${JSON.stringify(expected)}`,
  );

describe("Website.Vite build output", () => {
  for (const mode of ["live", "dev"] as const satisfies ReadonlyArray<Mode>) {
    // `explicit-resource-management`: workerd runs `using` natively, so the
    // Worker build keeps it and the Worker disposes in reverse order.
    (mode === "live" ? test : devTest).provider(
      `Vite build: keeps using declarations in the Worker${mode === "dev" ? " (dev)" : ""}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(explicitResourceManagementFixtureDir, {
            prefix: "alchemy-vite-explicit-resource-management-",
            tempRoot,
            entries: ["package.json", "vite.config.ts", "index.html", "src", "worker"],
          });
          const site = yield* stack.deploy(
            Cloudflare.Website.Vite(`ViteExplicitResourceManagement${mode}`, {
              rootDir,
              main: "./worker/index.ts",
              workersDev: true,
              compatibility: { date: "2024-12-30" },
              memo: { include: ["**/*"] },
              ...(mode === "dev" ? { dev: { port: 0 } } : {}),
            }),
          );
          const url = site.url!.replace(/\/$/, "");
          yield* expectText(`${url}/api`, `["socket","session"]`);
          if (mode === "live") {
            const output = yield* readWorkerOutput(rootDir);
            expect(output).toMatch(/\bawait using [\w$]+ =/);
            expect(output).toMatch(/\busing [\w$]+ =/);
            expect(output).not.toMatch(/__using|_usingCtx/);
            const { accountId } = yield* yield* CloudflareEnvironment;
            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(site.workerName, accountId);
          }
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      {
        tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
        timeout: 300_000,
      },
    );

    // `prerendering`: a build plugin renders a page through Vite's preview
    // server, where the Worker reaches another Worker over a service
    // binding, into the static assets (build only; dev serves the Worker).
    (mode === "live" ? test : devTest).provider(
      `Vite build: prerenders a page through the preview server${mode === "dev" ? " (dev)" : ""}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(prerenderingFixtureDir, {
            prefix: "alchemy-vite-prerendering-",
            tempRoot,
            entries: ["package.json", "vite.config.ts", "src"],
          });
          const site = yield* stack.deploy(
            Effect.gen(function* () {
              const auxiliary = yield* Cloudflare.Worker(`VitePrerenderingAuxiliary${mode}`, {
                main: pathe.join(rootDir, "src/auxiliary.ts"),
                compatibility: { date: "2024-12-30" },
                ...(mode === "dev" ? { dev: { port: 0 } } : {}),
              });
              return yield* Cloudflare.Website.Vite(`VitePrerendering${mode}`, {
                rootDir,
                main: "./src/index.ts",
                workersDev: true,
                compatibility: { date: "2024-12-30" },
                memo: { include: ["**/*"] },
                env: { AUXILIARY_WORKER: auxiliary },
                ...(mode === "dev" ? { dev: { port: 0 } } : {}),
              });
            }),
          );
          const url = site.url!.replace(/\/$/, "");
          yield* expectText(`${url}/hello`, "Hello world");
          if (mode === "live") {
            yield* expectResponse(`${url}/prerendered`, (res) =>
              res.status === 200 &&
              res.body.includes("<h1>Pre-rendered HTML from auxiliary Worker</h1>")
                ? undefined
                : `${res.status} ${res.body.slice(0, 300)}`,
            );
            const output = yield* readWorkerOutput(rootDir);
            expect(output).toMatch(/\busing [\w$]+ =/);
            expect(output).not.toMatch(/__using|_usingCtx/);
            const { accountId } = yield* yield* CloudflareEnvironment;
            yield* expectWorkerExists(site.workerName, accountId);
            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(site.workerName, accountId);
          }
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      {
        tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
        timeout: 300_000,
      },
    );
  }
});
