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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "vite-app");

// Clone under the alchemy package so `vite` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "index.html",
  "src",
  "public",
];

describe("AWS.Website.Vite local", () => {
  test.provider(
    "dev runs Vite's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vite-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Vite("ViteSite", {
              rootDir,
            });
            return { site };
          }),
        );

        // The site is Vite's own dev server: a localhost URL and no cloud
        // rows at all (proof no AWS call ran — and specifically NOT a
        // *.cloudfront.net URL).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.files).toBeUndefined();

        // The page serves through Vite's dev server (index.html transformed
        // on the fly, module scripts served from source).
        yield* expectUrlContains(`${url}/`, "VITE_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev index page",
        });
        // Source modules serve straight from src/ (no build ran).
        yield* expectUrlContains(
          `${url}/src/main.ts`,
          "VITE_AWS_MODULE_MARKER",
          { label: "dev module source" },
        );

        // ── HMR surface: edit index.html in place. The stack is NOT
        // re-applied — Vite's dev server serves the transformed html per
        // request, so the same URL must show the new marker ───────────────
        const indexPath = path.join(rootDir, "index.html");
        const index = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          index.replace("VITE_AWS_PAGE_MARKER", "VITE_AWS_PAGE_MARKER_V2"),
        );
        yield* expectUrlContains(`${url}/`, "VITE_AWS_PAGE_MARKER_V2", {
          timeout: "90 seconds",
          label: "index page after edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
