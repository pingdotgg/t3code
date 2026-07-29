import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { readPrebuiltWorkerBundle } from "@/Cloudflare/Workers/WorkerBundle";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/prebuilt/worker.mjs");

describe.concurrent("Cloudflare.Worker with bundle: false", () => {
  test.provider(
    "uploads a prebuilt module graph byte-for-byte",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        // The bundle the provider must upload, computed from the source
        // bytes on disk: entry first, additional modules named by their
        // POSIX path relative to the entry's directory.
        const expected = yield* readPrebuiltWorkerBundle({ main });
        expect(expected.files.map((file) => file.path)).toEqual([
          "worker.mjs",
          "lib/format.mjs",
          "lib/greeting.mjs",
          "lib/notice.txt",
        ]);

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("PrebuiltWorker", {
              main,
              bundle: false,
              subdomain: { enabled: true },
              compatibility: {
                date: "2024-01-01",
              },
            });
          }),
        );

        // The stored bundle hash equals the hash of the source bytes
        // only when no rolldown step ran — any re-bundling would
        // minify the files and change every content hash.
        expect(worker.hash?.bundle).toEqual(expected.hash);

        // End-to-end: the response is assembled from values that flow
        // through both nested ES modules and the nested text module, so
        // it only renders if the module names survived the upload.
        expect(worker.url).toBeDefined();
        yield* expectUrlContains(
          worker.url!,
          "prebuilt-modules-survived alchemy-prebuilt-notice-4d2a!",
        );

        // Re-deploy with no changes: the prebuilt hash must be stable.
        const redeployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("PrebuiltWorker", {
              main,
              bundle: false,
              subdomain: { enabled: true },
              compatibility: {
                date: "2024-01-01",
              },
            });
          }),
        );
        expect(redeployed.hash?.bundle).toEqual(expected.hash);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
