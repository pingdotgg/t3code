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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "octane-app");

// Clone under the alchemy package so `octane`/`@octanejs/*`/`vite` resolve
// from the workspace's hoisted node_modules (the fixture has no
// node_modules).
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

describe("AWS.Website.Octane local", () => {
  test.provider(
    "dev runs Octane's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Octane("OctaneSite", {
              rootDir,
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
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();

        // SSR page served by Octane's Vite dev server (native HMR
        // toolchain). NOTE: Octane's dev middleware supplies no platform
        // bindings — the plain dev server is the whole story here.
        yield* expectUrlContains(`${url}/`, "OCTANE_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // Server API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "OCTANE_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the page component in place. The stack is NOT
        // re-applied — Octane's Vite dev server must hot-update the module
        // and serve the new marker through the same URL ──────────────────
        const appPath = path.join(rootDir, "src/App.tsx");
        const app = yield* fs.readFileString(appPath);
        yield* fs.writeFileString(
          appPath,
          app.replace("OCTANE_AWS_PAGE_MARKER", "OCTANE_AWS_PAGE_MARKER_V2"),
        );
        yield* expectUrlContains(`${url}/`, "OCTANE_AWS_PAGE_MARKER_V2", {
          timeout: "90 seconds",
          label: "SSR page after HMR edit",
        });
        // The API route (octane.config.ts server route) survived the
        // client-module hot update.
        yield* expectUrlContains(
          `${url}/api/hello?echo=post-hmr`,
          "OCTANE_AWS_API_MARKER",
          { label: "API route after HMR edit" },
        );

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
