/**
 * `assets.base` on the precomputed-hash path.
 *
 * `Command.Build` / `StaticSite` deploys pass a caller-supplied asset hash
 * so unchanged builds skip the directory walk and keep the manifest
 * already on Cloudflare. Changing `base` re-keys the manifest without
 * changing the build output, so the caller-supplied hash stays identical —
 * the skip decision must incorporate the prefix or a stale root-keyed
 * manifest survives the deploy.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import { expectUrlAbsent, expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const marker = "assets-base-rekey-marker";

test.provider(
  "assets: changing base with an unchanged precomputed hash re-keys the manifest",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const directory = yield* fs.makeTempDirectory({
        prefix: "alchemy-assets-base-",
      });
      yield* fs.writeFileString(
        path.join(directory, "index.html"),
        `<!doctype html><html><body>${marker}</body></html>`,
      );

      // The hash stands in for a build-input hash: identical across both
      // deploys because the build output is identical — only `base` flips.
      const hash = "assets-base-rekey-v1";

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AssetsBaseWorker", {
              workersDev: true,
              assets: { directory, hash },
            });
          }),
        );
        workerName = first.workerName;
        expect(first.url).toBeDefined();

        yield* expectUrlContains(`${first.url!}/`, marker, {
          timeout: "120 seconds",
          label: "root-keyed manifest",
        });

        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AssetsBaseWorker", {
              workersDev: true,
              assets: { directory, hash, base: "/docs" },
            });
          }),
        );

        // The prefix must reach the served manifest even though the
        // caller-supplied hash did not change.
        yield* expectUrlContains(`${second.url!}/docs/`, marker, {
          timeout: "60 seconds",
          label: "base-keyed manifest",
        });
        yield* expectUrlAbsent(`${second.url!}/`, marker, {
          timeout: "60 seconds",
          label: "root no longer serves the shell",
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 300_000 },
);
