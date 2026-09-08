import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

describe("AWS.Website.Nextjs local", () => {
  test.provider(
    "dev runs Next's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // OpenNext detect the workspace as a monorepo and trace the server
        // bundle against bun's isolated-install symlink store, which drops
        // transitive deps (e.g. @swc/helpers) from the shipped node_modules.
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-local-",
          entries: fixtureEntries,
        });
        yield* prepareNextjsFixture(rootDir);

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nextjs("NextjsSite", {
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
        expect(deployed.site.revalidationQueue).toBeUndefined();
        expect(deployed.site.tagCacheTable).toBeUndefined();

        // SSR page served by the next dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "dev SSR home page",
        });
        // App Router API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NEXTJS_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the App Router route in place. The stack is NOT
        // re-applied — next dev must recompile the route and serve it
        // through the same URL ───────────────────────────────────────────
        const routePath = path.join(rootDir, "app/api/hello/route.ts");
        const route = yield* fs.readFileString(routePath);
        yield* fs.writeFileString(
          routePath,
          route.replace("NEXTJS_AWS_API_MARKER", "NEXTJS_AWS_API_MARKER_V2"),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NEXTJS_AWS_API_MARKER_V2",
          { timeout: "120 seconds", label: "API route after HMR edit" },
        );
        // The route still round-trips its query after the recompile.
        yield* expectUrlContains(`${url}/api/hello?echo=post-hmr`, "post-hmr", {
          label: "API route query echo after HMR edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
