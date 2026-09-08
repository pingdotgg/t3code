import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "astro-app");

// Clone under the alchemy package so `astro` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "astro.config.mjs",
  "src",
  "public",
];

describe("AWS.Website.Astro local", () => {
  test.provider(
    "dev runs Astro's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Astro("AstroSite", {
              rootDir,
              // Pin the dev server to a deterministic port — `dev.port`
              // flows through Server's port probe into the framework kit.
              dev: { port: 43117 },
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
        // The preferred `dev.port` was honored.
        expect(url).toContain(":43117");
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();

        // SSR page served by the astro dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "ASTRO_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "ASTRO_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the API route in place. The stack is NOT re-applied —
        // astro's dev rebuild must pick the change up and serve it through
        // the same URL ───────────────────────────────────────────────────
        const helloPath = path.join(rootDir, "src/pages/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace("ASTRO_AWS_API_MARKER", "ASTRO_AWS_API_MARKER_V2"),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "ASTRO_AWS_API_MARKER_V2",
          { timeout: "90 seconds", label: "API route after HMR edit" },
        );
        // The route still round-trips its query after the reload.
        yield* expectUrlContains(`${url}/api/hello?echo=post-hmr`, "post-hmr", {
          label: "API route query echo after HMR edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
