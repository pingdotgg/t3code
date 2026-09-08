import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectDirectStatus, expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Same rationale as Vite.test.ts: Vite's `vite:build-html` plugin expresses
// emitted asset paths relative to `cwd`, so the temp clone has to live under
// the same workspace root.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureDir = pathe.resolve(import.meta.dirname, "foldkit-fixture");
const workerFixtureDir = pathe.resolve(
  import.meta.dirname,
  "foldkit-worker-fixture",
);

const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

// Restrict the input memo to fixture sources so the test isn't re-hashing
// the whole monorepo on every deploy.
const memoInclude = ["index.html", "src/**", "package.json", "vite.config.ts"];

const foldkitProps = (rootDir: string) => ({
  rootDir,
  workersDev: true,
  compatibility: {
    date: "2024-09-23",
    flags: ["nodejs_compat"],
  },
  memo: { include: memoInclude },
});

const htmlPage = (marker: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${marker}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/entry.ts"></script>
  </body>
</html>
`;

describe.concurrent("Foldkit", () => {
  // The resource's reason to exist: a Foldkit app routes on the client, so
  // `notFoundHandling` defaults to `single-page-application` and deep links
  // boot the app without the caller configuring anything. The same project
  // through `Website.Vite` 404s on `/counter/42` unless `assets` is passed
  // by hand.
  test.provider(
    "Foldkit: deploys with SPA fallback by default",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-default-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            // Deliberately no `assets` — the default is what's under test.
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitDefault",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.hash?.input).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "120 seconds",
          label: "foldkit index",
        });
        // Deep link falls back to index.html so client-side routing can boot.
        yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit spa fallback",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // An explicit `assets` must win over the built-in default rather than be
  // overridden by it — a spread in the wrong order would silently ignore
  // whatever the caller passed.
  test.provider(
    "Foldkit: an explicit assets config overrides the SPA default",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-override-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit("FixFoldkitOverride", {
              ...foldkitProps(rootDir),
              assets: {
                notFoundHandling: "none",
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The app itself still serves...
        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "120 seconds",
          label: "foldkit override index",
        });
        // ...but with `notFoundHandling: "none"` the deep link is a miss
        // rather than an index.html fallback.
        yield* expectDirectStatus(`${site.url!}/counter/42`, 404, {
          timeout: "60 seconds",
          label: "foldkit override deep link",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // A Foldkit deployment may carry a Worker entry in front of the assets
  // (API routes, error reporting, Durable Objects). The client build still
  // serves through the ASSETS binding, and the SPA fallback still applies
  // behind it.
  test.provider(
    "Foldkit: a custom main entry serves API routes alongside the app",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(workerFixtureDir, {
          prefix: "alchemy-foldkit-worker-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit("FixFoldkitWorker", {
              ...foldkitProps(rootDir),
              main: "src/worker.ts",
              assets: {
                runWorkerFirst: ["/api/*"],
              },
              env: {
                GREETING: "foldkit-worker-fixture",
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The Worker entry answers its own route from the binding.
        yield* expectUrlContains(
          `${site.url!}/api/hello`,
          "foldkit-worker-fixture",
          { timeout: "120 seconds", label: "foldkit worker api" },
        );
        // Everything else passes through to the assets binding.
        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit worker index",
        });
        // `runWorkerFirst` is merged over the SPA default, not instead of
        // it — the deep link still falls back through `env.ASSETS.fetch`.
        yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit worker spa fallback",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // Editing a source file must change the input hash so the next deploy
  // rebuilds — the memo is keyed on the project tree, not on wall time.
  test.provider(
    "Foldkit: editing a source file republishes the assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-edit-",
          tempRoot,
          entries: fixtureEntries,
        });
        const indexPath = path.join(rootDir, "index.html");

        const v1Marker = "foldkit-v1-marker";
        yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

        const site1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitEdit",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site1.hash?.input).toBeDefined();
        yield* expectUrlContains(`${site1.url!}/`, v1Marker, {
          timeout: "120 seconds",
          label: "foldkit edit v1",
        });

        const v2Marker = "foldkit-v2-marker";
        yield* fs.writeFileString(indexPath, htmlPage(v2Marker));

        const site2 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitEdit",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site2.hash?.input).toBeDefined();
        expect(site2.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site2.url!}/`, v2Marker, {
          timeout: "60 seconds",
          label: "foldkit edit v2",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
