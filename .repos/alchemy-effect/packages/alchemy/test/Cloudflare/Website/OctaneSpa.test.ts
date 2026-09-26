import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "octane-spa-app",
);

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd —
// and so `octane`/`@octanejs/vite-plugin` resolve from the workspace's
// hoisted node_modules when the fixture's own tree has none.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

const memoInclude = [
  "src/**",
  "public/**",
  "index.html",
  "vite.config.ts",
  "package.json",
];

/** The shell marker baked into the fixture's `index.html` head. */
const SPA_SHELL_MARKER = "octane-spa-shell";

// ─────────────────────────────────────────────────────────────────────
// Octane SPA via `Website.Vite` — the documented path for route-less,
// client-only Octane apps (no `octane.config.ts`): the `octane()`
// compiler plugin in the app's own `vite.config.ts` composes with the
// injected Cloudflare Vite plugin, the project builds as a plain Vite
// SPA (assets only), and `notFoundHandling: "single-page-application"`
// makes deep links serve the app shell so the client router/app boots.
// Fullstack Octane apps (routes + SSR) are covered by Octane.test.ts.
// ─────────────────────────────────────────────────────────────────────
describe.concurrent("OctaneSpa", () => {
  test.provider(
    "Vite: client-only Octane app deploys as a SPA with shell fallback",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-spa-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Vite("OctaneSpaSite", {
              rootDir,
              workersDev: { enabled: true, previewsEnabled: true },
              memo: { include: memoInclude },
              assets: {
                notFoundHandling: "single-page-application",
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.hash?.input).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // (a) `/` serves the app shell (identified by the head marker).
        // The page markup renders only in the browser, so its marker must
        // be absent from the raw HTML.
        const shellBody = yield* expectUrlContains(
          `${site.url!}/`,
          SPA_SHELL_MARKER,
          {
            timeout: "120 seconds",
            label: "SPA shell at /",
          },
        );
        expect(shellBody).not.toContain("OCTANE_SPA_PAGE_MARKER");

        // (b) A hard GET to an unregistered deep route serves the shell
        // with a 200 (`expectUrlContains` requires `res.ok`) — the SPA
        // fallback that lets the client-side app boot on any URL.
        const deepBody = yield* expectUrlContains(
          `${site.url!}/widgets/42`,
          SPA_SHELL_MARKER,
          {
            timeout: "60 seconds",
            label: "deep link serves SPA shell",
          },
        );
        expect(deepBody).not.toContain("OCTANE_SPA_PAGE_MARKER");

        // (c) The hydrating client bundle serves and carries the content
        // the browser renders: extract the hashed module the shell loads
        // and assert the page marker is inside it.
        const scriptSrc = shellBody.match(/\/assets\/[^"']+\.js/)?.[0];
        expect(scriptSrc).toBeDefined();
        yield* expectUrlContains(
          `${site.url!}${scriptSrc!}`,
          "OCTANE_SPA_PAGE_MARKER",
          {
            timeout: "60 seconds",
            label: "client bundle carries the page content",
          },
        );

        // (d) A `public/` asset serves its own bytes.
        const robots = yield* expectUrlContains(
          `${site.url!}/robots.txt`,
          "User-agent",
          {
            timeout: "60 seconds",
            label: "static asset with SPA handling",
          },
        );
        expect(robots).not.toContain(SPA_SHELL_MARKER);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
