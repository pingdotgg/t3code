import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "octane-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "octane.config.ts",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

const memoInclude = [
  "src/**",
  "public/**",
  "index.html",
  "octane.config.ts",
  "vite.config.ts",
  "package.json",
];

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Octane dev", () => {
  test.provider(
    "Octane dev: local dev server renders SSR and picks up edits",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-dev-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Cloudflare.Website.Octane("OctaneLocal", {
            rootDir,
            dev: { port: 0 },
            memo: { include: memoInclude },
          }),
        );

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // SSR page rendered by Octane's dev middleware behind the proxy.
        yield* expectUrlContains(`${site.url!}/`, "OCTANE_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "octane dev SSR home page",
        });

        // Server route through the same middleware. Octane's dev server
        // supplies no `context.platform` (upstream limitation), so the
        // handler degrades to a null binding — the route itself must work.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
          hasWaitUntil: boolean;
        }>(`${site.url!}/api/hello`);
        expect(hello.marker).toBe("api-route-ok");
        expect(hello.binding).toBeNull();
        expect(hello.hasWaitUntil).toBe(false);

        // ── HMR: edit the page in place. The stack is NOT re-applied — the
        // dev server must pick the change up and serve it through the same
        // alchemy proxy ──────────────────────────────────────────────────────
        const appPath = path.join(rootDir, "src/App.tsx");
        const app = yield* fs.readFileString(appPath);
        yield* fs.writeFileString(
          appPath,
          app.replace("OCTANE_PAGE_MARKER", "OCTANE_PAGE_MARKER_V2"),
        );

        yield* expectUrlContains(`${site.url!}/`, "OCTANE_PAGE_MARKER_V2", {
          timeout: "90 seconds",
          label: "octane dev SSR page after edit",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the whole site OUT of local emulation: even under
   * `alchemy dev` the Worker builds and deploys to real Cloudflare (pinning
   * the stamped-mode delete path on destroy). This is the supported way to
   * exercise bindings during dev while Octane's dev middleware cannot serve
   * `context.platform`.
   */
  test.provider(
    "Octane dev: Alchemy.remote() deploys the real Worker",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-dev-remote-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "octane-dev-remote-marker";

        const site = yield* stack.deploy(
          Cloudflare.Website.Octane("OctaneRemoteSite", {
            rootDir,
            workersDev: { enabled: true, previewsEnabled: true },
            memo: { include: memoInclude },
            env: {
              TEST_BINDING: bindingMarker,
            },
          }).pipe(Alchemy.remote()),
        );

        // A real deployment: workers.dev URL, not the local proxy.
        expect(site.url).toBeDefined();
        expect(site.url).not.toMatch(/^http:\/\/localhost/);

        yield* expectUrlContains(`${site.url!}/`, "OCTANE_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "remote() SSR home page in dev mode",
        });

        // The deployed worker carries the real binding through
        // `context.platform.env`.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
          hasWaitUntil: boolean;
        }>(`${site.url!}/api/hello`);
        expect(hello.marker).toBe("api-route-ok");
        expect(hello.binding).toBe(bindingMarker);
        expect(hello.hasWaitUntil).toBe(true);

        yield* stack.destroy();

        // The stamped-live row deletes the real Worker even in a dev run.
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});

/** GET `url` until it answers 200 with a JSON body. */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 10,
      }),
    );
  });
