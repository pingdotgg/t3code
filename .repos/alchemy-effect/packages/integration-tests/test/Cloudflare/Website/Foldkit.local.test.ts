import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Same rationale as Vite.test.ts: Vite's `vite:build-html` plugin expresses
// emitted asset paths relative to `cwd`, so the temp clone has to live under
// the same workspace root.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const ssrFixtureDir = pathe.resolve(import.meta.dirname, "foldkit-ssr-fixture");

const fixtureEntries = ["package.json", "vite.config.ts", "src"];

// Restrict the input memo to fixture sources so the test isn't re-hashing
// the whole monorepo on every deploy.
const memoInclude = ["index.html", "src/**", "package.json", "vite.config.ts"];

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent(
  "Foldkit dev",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:website", "provider:cloudflare:worker"],
  },
  () => {
    // A server-rendered app names no Worker entry of its own, so workerd
    // serves assets alone in dev and Vite's `ssr` environment stays runnable:
    // the Foldkit plugin renders through it exactly as under the app's own
    // `vite dev`. Each page stamps the `count` query into its markup, which
    // is what tells a render from a served template.
    test.provider(
      "Foldkit dev: a server-rendered app renders through the local dev server",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(ssrFixtureDir, {
            prefix: "alchemy-foldkit-dev-ssr-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitSsrLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
            }),
          );

          // Local identity: the url points at the alchemy dev proxy — no
          // cloud Worker exists.
          expect(site.url).toBeDefined();
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

          // The front page renders on request — a served template would
          // carry an empty `<div id="root">` and no count at all.
          yield* expectUrlContains(`${site.url!}/?count=7`, ">7<", {
            timeout: "30 seconds",
            label: "foldkit dev ssr front page",
          });
          // A deep link is rendered too; nothing is prerendered in dev.
          yield* expectUrlContains(`${site.url!}/counter/42?count=3`, ">3<", {
            timeout: "15 seconds",
            label: "foldkit dev ssr deep link",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"], timeout: 120_000 },
    );

    /**
     * `Alchemy.remote()` opts the whole site OUT of local emulation: even under
     * `alchemy dev` the build runs, the fetch handler it emits deploys to real
     * Cloudflare, and destroy deletes the cloud Worker (the state row is
     * stamped live).
     */
    test.provider(
      "Foldkit dev: Alchemy.remote() deploys the real Worker and destroy removes it",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneFixture(ssrFixtureDir, {
            prefix: "alchemy-foldkit-dev-remote-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitRemoteSite", {
              rootDir,
              workersDev: true,
              compatibility: {
                date: "2024-09-23",
                flags: ["nodejs_compat"],
              },
              memo: { include: memoInclude },
            }).pipe(Alchemy.remote()),
          );

          // Real identity: a non-local URL and a Worker that exists on
          // Cloudflare.
          expect(site.url).toBeDefined();
          expect(site.url).not.toMatch(/^http:\/\/localhost/);
          yield* expectWorkerExists(site.workerName, accountId);

          // The deployed handler renders the front page on request.
          yield* expectUrlContains(`${site.url!}/?count=7`, ">7<", {
            timeout: "30 seconds",
            label: "remote() foldkit ssr front page in dev mode",
          });
          // The route the fixture prerenders is a file: the query never
          // reaches a render.
          yield* expectUrlContains(`${site.url!}/about/?count=7`, ">0<", {
            timeout: "15 seconds",
            label: "remote() foldkit prerendered page in dev mode",
          });

          yield* stack.destroy();

          // The stamped-live row deletes the real Worker even in a dev run.
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
    );
  },
);
