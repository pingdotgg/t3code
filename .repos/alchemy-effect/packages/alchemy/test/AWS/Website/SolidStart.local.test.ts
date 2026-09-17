import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains, expectUrlOk } from "../../Cloudflare/Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

/**
 * SolidStart 2's dev SSR does not run under Bun.
 *
 * `solid-start-dev-server` answers every request through
 * `sendNodeResponse(res, webRes)` from `srvx/node`; under Bun that writes the
 * literal string `[object Object]` (HTTP 200, 15 bytes) instead of the
 * rendered document. Under Node the same code path returns the SSR HTML.
 * Verified directly against the framework integration:
 *
 *     node  -> STATUS 200 LEN 1070 "<!DOCTYPE html><html lang=\"en\">..."
 *     bun   -> STATUS 200 LEN 15   "[object Object]"
 *
 * `alchemy dev` hosts local providers in a Bun sidecar
 * (`bun run src/AWS/Website/ServerLocal.ts`), so the body assertions below
 * cannot pass until the upstream `srvx`/Bun gap is closed. Everything the
 * dev provider itself owns — the server starting, its address, and the
 * absence of cloud resources — is asserted unconditionally in the first test.
 *
 * Set `ALCHEMY_TEST_SOLIDSTART_DEV_SSR=1` to run the body assertions on a
 * Node-hosted sidecar.
 */
const runDevSsr = process.env.ALCHEMY_TEST_SOLIDSTART_DEV_SSR === "1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "solidstart-app",
);

// Clone under the alchemy package so `@solidjs/start`, `vite`, and
// `@solidjs/vite-plugin-nitro-2` resolve from the workspace's hoisted
// node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "vite.config.ts",
  "src",
  "public",
];

describe("AWS.Website.SolidStart local", () => {
  test.provider(
    "dev runs SolidStart's own Vite dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.SolidStart("SolidStartSite", {
              rootDir,
              env: {
                SOLIDSTART_ENV_MARKER: "solidstart-aws-dev-env-marker",
              },
            });
            return { site };
          }),
        );

        // The site is the framework's own dev server: a localhost URL and
        // no cloud rows at all (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        // The URL is an origin, not a directory — appending a path must not
        // produce a double slash (SolidStart runs `appType: "custom"`, so its
        // router sees the raw pathname and `//about` is a 404).
        expect(url.endsWith("/")).toBe(false);
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();

        // The dev server is reachable from another process.
        expect(yield* expectUrlOk(`${url}/`)).toBe(200);

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );

  // Body-level assertions: gated on a Node-hosted dev sidecar (see the note
  // on `runDevSsr` above).
  test.provider.skipIf(!runDevSsr)(
    "dev serves SSR, the project's vite.config.ts, injected env, and HMR",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-aws-local-ssr-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.SolidStart("SolidStartSite", {
              rootDir,
              env: {
                SOLIDSTART_ENV_MARKER: "solidstart-aws-dev-env-marker",
              },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;

        // SSR page served by the SolidStart dev server (native HMR).
        yield* expectUrlContains(`${url}/`, "SOLIDSTART_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // The fixture's own vite.config.ts applied in dev too.
        yield* expectUrlContains(
          `${url}/`,
          "config:solidstart-aws-user-config-loaded",
          { label: "user vite.config.ts applied (dev)" },
        );
        // server.environment reaches the dev server's process env — the
        // same values the Lambda gets on deploy (dev/live parity).
        yield* expectUrlContains(
          `${url}/`,
          "env:solidstart-aws-dev-env-marker",
          { label: "server.environment injected into dev server" },
        );
        // API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "SOLIDSTART_AWS_API_MARKER",
          { label: "API route (dev)" },
        );

        // ── HMR: edit the API route in place. The stack is NOT re-applied —
        // vite's dev rebuild must pick the change up and serve it through
        // the same URL ───────────────────────────────────────────────────
        const helloPath = path.join(rootDir, "src/routes/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace(
            "SOLIDSTART_AWS_API_MARKER",
            "SOLIDSTART_AWS_API_MARKER_V2",
          ),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "SOLIDSTART_AWS_API_MARKER_V2",
          { timeout: "90 seconds", label: "API route after HMR edit" },
        );

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
