import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  findWorker,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "staticsite-fixture");
const workerEntry = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const staticSiteProps = (cwd: string): Cloudflare.Website.StaticSiteProps => ({
  command: "bash build.sh",
  shell: true,
  cwd,
  outdir: "dist",
  main: workerEntry,
  workersDev: true,
  compatibility: { date: "2024-01-01" },
});

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("StaticSite dev", () => {
  /**
   * The `dev.command` path: `alchemy dev` skips the build entirely and spawns
   * the command as a long-lived child in the sidecar (`Command.Dev`). The URL
   * the child prints to stdout becomes the site's `url`, and the Worker opts
   * out of local emulation (`dev: { mode: "external" }`) — the dev server IS
   * the site.
   */
  test.provider(
    "StaticSite dev: dev.command serves the site through the external dev server",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-cmd-",
          tempRoot,
          entries: ["src", "build.sh", "serve.mjs", ".gitignore"],
        });

        const marker = "staticsite-dev-command-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite("DevCmdSite", {
              ...staticSiteProps(cwd),
              dev: {
                command: "bun serve.mjs",
                env: { DEV_MARKER: "staticsite-dev-env-marker" },
              },
            });
          }),
        );

        // The site's url is the dev server's own localhost address,
        // extracted from the child's stdout.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // Content serves through the dev server straight from `src/`.
        yield* expectUrlContains(`${site.url!}/`, marker, {
          timeout: "60 seconds",
          label: "dev.command index",
        });
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "30 seconds",
          label: "dev.command explicit path",
        });

        // `dev.env` reached the spawned child process.
        yield* expectUrlContains(
          `${site.url!}/__dev-env`,
          "staticsite-dev-env-marker",
          {
            timeout: "30 seconds",
            label: "dev.command env passthrough",
          },
        );

        // The build command was skipped — `dist/` was never produced.
        expect(yield* fs.exists(path.join(cwd, "dist"))).toBe(false);

        // No cloud Worker was created (external dev mode still records the
        // real worker name in its stub attributes).
        expect(site.workerName).toBeDefined();
        expect(yield* findWorker(site.workerName, accountId)).toBeUndefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * Without `dev.command`, a dev run falls back to build mode: the build
   * command runs (producing `dist/`) and the Worker serves the built assets
   * from a local simulator — the `url` is a localhost dev-proxy address and
   * no cloud Worker exists.
   */
  test.provider(
    "StaticSite dev: without dev.command the build runs and a local Worker serves the assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-build-",
          tempRoot,
          entries: ["src", "build.sh", ".gitignore"],
        });

        const marker = "staticsite-dev-build-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "DevBuildSite",
              staticSiteProps(cwd),
            );
          }),
        );

        // Local identity: the url points at the local dev proxy.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // The build ran — `dist/` exists with the built page.
        expect(yield* fs.exists(path.join(cwd, "dist", "index.html"))).toBe(
          true,
        );

        // The built assets serve through the local Worker simulator.
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "60 seconds",
          label: "dev build-mode assets",
        });

        // No cloud Worker was created.
        expect(yield* findWorker(site.workerName, accountId)).toBeUndefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the whole site OUT of local emulation: even in a
   * dev run, the build executes and the Worker deploys to real Cloudflare.
   * Destroy deletes the cloud Worker (the state row is stamped live).
   */
  test.provider(
    "StaticSite dev: Alchemy.remote() deploys the real Worker and destroy removes it",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-remote-",
          tempRoot,
          entries: ["src", "build.sh", ".gitignore"],
        });

        const marker = "staticsite-dev-remote-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "RemoteSite",
              staticSiteProps(cwd),
            ).pipe(Alchemy.remote());
          }),
        );

        // Real identity: a non-local URL and a Worker that exists on
        // Cloudflare.
        expect(site.url).toBeDefined();
        expect(site.url).not.toMatch(/^http:\/\/localhost/);
        yield* expectWorkerExists(site.workerName, accountId);

        // The real workers.dev URL serves the built assets.
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "remote() site marker",
        });

        yield* stack.destroy();

        // The cloud Worker is gone after destroy (stamped-mode delete).
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
