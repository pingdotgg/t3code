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

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "staticsite-dev",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

describe("AWS.Website.StaticSite local", () => {
  /**
   * The `dev.command` path: `alchemy dev` skips the build/upload entirely
   * and spawns the command as a long-lived child in the sidecar
   * (`Command.Dev`). The URL the child prints to stdout becomes the site's
   * `url`, and no cloud resources are declared at all.
   */
  test.provider(
    "dev.command serves the site through the external dev server",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-aws-staticsite-dev-cmd-",
          tempRoot,
          entries: ["serve.mjs", "site"],
        });

        const marker = "aws-staticsite-dev-command-marker";
        yield* fs.writeFileString(
          path.join(cwd, "site", "index.html"),
          htmlPage(marker),
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("DevCmdSite", {
              path: cwd,
              dev: {
                command: "bun serve.mjs",
                env: { DEV_MARKER: "aws-staticsite-dev-env-marker" },
              },
            });
            return { site };
          }),
        );

        // The site's url is the dev server's own localhost address,
        // extracted from the child's stdout — and no cloud rows exist
        // (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.files).toBeUndefined();

        // Dev-mode urls contract: `urls` is exactly the dev server's URL
        // and `url` is always `urls[0]`.
        expect(deployed.site.urls).toEqual([url]);
        expect(deployed.site.url).toBe(deployed.site.urls[0]);

        // Content serves through the dev server straight from `site/`.
        yield* expectUrlContains(`${url}/`, marker, {
          timeout: "60 seconds",
          label: "dev.command index",
        });
        yield* expectUrlContains(`${url}/index.html`, marker, {
          timeout: "30 seconds",
          label: "dev.command explicit path",
        });

        // `dev.env` reached the spawned child process.
        yield* expectUrlContains(
          `${url}/__dev-env`,
          "aws-staticsite-dev-env-marker",
          {
            timeout: "30 seconds",
            label: "dev.command env passthrough",
          },
        );

        // ── Live edit: rewrite the content in place. The stack is NOT
        // re-applied — the external dev server reads from disk per request,
        // so the very next fetch must serve the new content ──────────────
        const editedMarker = "aws-staticsite-dev-command-marker-v2";
        yield* fs.writeFileString(
          path.join(cwd, "site", "index.html"),
          htmlPage(editedMarker),
        );
        yield* expectUrlContains(`${url}/`, editedMarker, {
          timeout: "30 seconds",
          label: "dev.command index after live edit",
        });
        // `dev.env` still reaches the (unchanged, long-lived) child.
        yield* expectUrlContains(
          `${url}/__dev-env`,
          "aws-staticsite-dev-env-marker",
          { label: "dev.command env passthrough after live edit" },
        );

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );
});
