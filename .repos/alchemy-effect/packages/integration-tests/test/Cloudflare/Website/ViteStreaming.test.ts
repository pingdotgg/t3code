import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// Streamed responses from a `Website.Vite` Worker, mirroring
// `@cloudflare/vite-plugin`'s `streaming` playground: each chunk reaches the
// client as the Worker writes it, deployed, under `alchemy dev`, and with the
// dev server on HTTPS.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureDir = pathe.resolve(import.meta.dirname, "vite-streaming-fixture");

// Reads the response, noting when each marker first arrives.
const readStream = (url: string) =>
  Effect.tryPromise(async () => {
    const start = Date.now();
    const response = await fetch(url, {
      // The HTTPS dev server's certificate is self-signed.
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    if (response.status !== 200 || !response.body) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const decoder = new TextDecoder();
    const arrivals: Record<string, number> = {};
    let body = "";
    for await (const chunk of response.body) {
      body += decoder.decode(chunk, { stream: true });
      for (const marker of ["<h1>Streaming example</h1>", `<p id="one">`, `<p id="two">`]) {
        if (body.includes(marker)) arrivals[marker] ??= Date.now() - start;
      }
    }
    return { body, arrivals };
  }).pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("2 seconds") }));

const variants = [
  { mode: "live", config: undefined },
  { mode: "dev", config: undefined },
  { mode: "dev", config: "https" },
] as const;

describe("Website.Vite streaming", () => {
  for (const { mode, config } of variants) {
    const id = `ViteStreaming${mode}${config ?? ""}`;
    (mode === "live" ? test : devTest).provider(
      `Vite streaming: renders an HTML stream chunk by chunk${mode === "dev" ? ` (dev${config ? `, ${config}` : ""})` : ""}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vite-streaming-",
            tempRoot,
            entries: ["package.json", "configs", "src"],
          });
          if (config) {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.copyFile(
              pathe.join(rootDir, `configs/${config}.ts`),
              pathe.join(rootDir, "vite.config.ts"),
            );
          }
          const site = yield* stack.deploy(
            Cloudflare.Website.Vite(id, {
              rootDir,
              main: "./src/index.ts",
              workersDev: true,
              compatibility: { date: "2024-12-30" },
              memo: { include: ["**/*"] },
              ...(mode === "dev" ? { dev: { port: 0 } } : {}),
            }),
          );
          const url = site.url!;
          if (config === "https") expect(url).toMatch(/^https:/);
          const { body, arrivals } = yield* readStream(url);
          expect(body).toContain(`<p id="two">Chunk after 2 seconds</p>`);
          if (mode === "dev") {
            // The heading arrives a second before the next chunk is written,
            // and that chunk a second before the last. (Deployed, the edge
            // delivers this stream in one piece, as it does for Wrangler's.)
            const heading = arrivals["<h1>Streaming example</h1>"]!;
            const one = arrivals[`<p id="one">`]!;
            const two = arrivals[`<p id="two">`]!;
            expect(one - heading).toBeGreaterThan(500);
            expect(two - one).toBeGreaterThan(500);
          } else {
            const { accountId } = yield* yield* CloudflareEnvironment;
            yield* expectWorkerExists(site.workerName, accountId);
            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(site.workerName, accountId);
          }
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      {
        tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
        timeout: 300_000,
        // The chunk timing must not absorb event-loop stalls from tests
        // running alongside in this process.
        exclusive: mode === "dev",
      },
    );
  }
});
