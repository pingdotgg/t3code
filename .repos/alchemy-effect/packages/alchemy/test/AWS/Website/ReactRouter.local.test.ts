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

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "react-router-app",
);

// Clone under the alchemy package so `@react-router/dev`, `react-router`,
// `@react-router/node`, `isbot`, `react`, and `vite` resolve from the
// workspace's node_modules (the fixture has none of its own).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "react-router.config.ts",
  "vite.config.ts",
  "app",
  "public",
];

describe("AWS.Website.ReactRouter local", () => {
  test.provider(
    "dev runs React Router's own Vite dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-react-router-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.ReactRouter("ReactRouterSite", {
              rootDir,
              env: {
                REACT_ROUTER_ENV_MARKER: "react-router-aws-dev-env-marker",
              },
            });
            return { site };
          }),
        );

        // The site is the framework's own dev server: a localhost URL and no
        // cloud rows at all (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        // The URL is an origin, not a directory — appending a path must not
        // produce a double slash.
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

  test.provider(
    "dev serves SSR, the project's vite.config.ts, injected env, and HMR",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-react-router-aws-local-ssr-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.ReactRouter("ReactRouterSite", {
              rootDir,
              env: {
                REACT_ROUTER_ENV_MARKER: "react-router-aws-dev-env-marker",
              },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;

        // SSR page served by the React Router dev server (native HMR).
        yield* expectUrlContains(`${url}/`, "REACT_ROUTER_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // The fixture's own vite.config.ts applied in dev too.
        yield* expectUrlContains(
          `${url}/`,
          "config:react-router-aws-user-config-loaded",
          { label: "user vite.config.ts applied (dev)" },
        );
        // server.environment reaches the dev server's process env — the same
        // values the Lambda gets on deploy (dev/live parity).
        yield* expectUrlContains(
          `${url}/`,
          "env:react-router-aws-dev-env-marker",
          { label: "server.environment injected into dev server" },
        );
        // Resource route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "REACT_ROUTER_AWS_API_MARKER",
          { label: "resource route (dev)" },
        );

        // ── HMR: edit the resource route in place. The stack is NOT
        // re-applied — vite's dev rebuild must pick the change up and serve
        // it through the same URL ─────────────────────────────────────────
        const helloPath = path.join(rootDir, "app/routes/api.hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace(
            "REACT_ROUTER_AWS_API_MARKER",
            "REACT_ROUTER_AWS_API_MARKER_V2",
          ),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "REACT_ROUTER_AWS_API_MARKER_V2",
          { timeout: "90 seconds", label: "resource route after HMR edit" },
        );

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
