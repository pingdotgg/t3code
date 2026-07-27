import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import {
  expectUrlAbsent,
  expectUrlContains,
  expectUrlHeader,
  expectUrlRedirect,
} from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/assets-config");

const workerScript = (marker: string) => `
export default {
  fetch: async () => new Response(${JSON.stringify(marker)}),
};
`;

// Regression test for https://github.com/alchemy-run/alchemy/issues/927:
// `_redirects` / `_headers` were read from the assets directory and folded
// into the change-detection hash, but their contents were never sent to
// Cloudflare, so the rules silently never applied.
describe.concurrent("Cloudflare.Worker assets config files", () => {
  test.provider(
    "redirects and headers apply, update, and survive keep-assets deploys",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const deploy = (
          assets: string | { directory: string; hash: string },
          marker: string,
        ) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("AssetsConfigFiles", {
                script: workerScript(marker),
                assets,
                subdomain: { enabled: true },
                compatibility: {
                  date: "2024-01-01",
                },
              });
            }),
          );

        // 1. Fresh deploy: rules from the fixture's `_redirects` /
        //    `_headers` must reach Cloudflare and apply.
        const worker = yield* deploy(fixtureDir, "worker-v1");
        const url = worker.url!;
        yield* expectUrlContains(`${url}/`, "alchemy-assets-config-index");
        yield* expectUrlRedirect(`${url}/old-path`, "/index.html", {
          status: 301,
          label: "initial redirect",
        });
        yield* expectUrlHeader(
          `${url}/`,
          "x-alchemy-test",
          "assets-config-header",
          { label: "initial header" },
        );
        // The special files themselves stay excluded from serving.
        yield* expectUrlAbsent(`${url}/_redirects`, "/old-path", {
          timeout: "15 seconds",
          label: "_redirects not served",
        });

        // 2. Update: editing only `_redirects` must deploy the new rules.
        const dir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-assets-config-",
        });
        yield* fs.writeFileString(
          path.join(dir, "_redirects"),
          "/moved /index.html 302\n",
        );
        yield* deploy(dir, "worker-v2");
        yield* expectUrlRedirect(`${url}/moved`, "/index.html", {
          status: 302,
          label: "updated redirect",
        });
        // The old rule is gone: `/old-path` now falls through to the
        // user worker instead of redirecting.
        yield* expectUrlContains(`${url}/old-path`, "worker-v2", {
          label: "removed redirect falls through",
        });

        // 3. Precomputed-hash deploys: the first one uploads, the second
        //    hits the keep-assets skip path (hash matches stored state)
        //    which never walks the directory — it must still re-send the
        //    `_redirects` / `_headers` contents or the PUT wipes them.
        const prebuilt = { directory: dir, hash: "assets-config-files-test" };
        yield* deploy(prebuilt, "worker-v3");
        yield* expectUrlContains(`${url}/some-worker-route`, "worker-v3");
        yield* deploy(prebuilt, "worker-v4");
        // Once the new script serves, the skip-path deploy has landed.
        yield* expectUrlContains(`${url}/some-worker-route`, "worker-v4");
        yield* expectUrlRedirect(`${url}/moved`, "/index.html", {
          status: 302,
          label: "redirect after keep-assets deploy",
        });
        yield* expectUrlHeader(
          `${url}/`,
          "x-alchemy-test",
          "assets-config-header",
          { label: "header after keep-assets deploy" },
        );

        yield* stack.destroy();
      }),
    { timeout: 360_000 },
  );
});
