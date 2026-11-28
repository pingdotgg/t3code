import { spawn } from "node:child_process";
/**
 * Cross-version upgrade tests for moving AWS framework sites onto Lambda Web
 * Functions.
 *
 * A temp project deploys a site with the PUBLISHED alchemy and
 * frontend-frameworks 2.0.0-beta.81 (SSR on a Lambda Function URL), then the
 * CURRENT workspace version re-deploys over the same local state. The site
 * must move onto Web Functions and keep its CloudFront distribution, and
 * the old functions must be deleted.
 */
import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

const PUBLISHED = "2.0.0-beta.81";
const STACK = "WebFunctionUpgradeTest";
const STAGE = "wfupgrade";

const repoRoot = pathe.resolve(import.meta.dirname, "../../../../..");
const workspaceCli = pathe.join(repoRoot, "packages/alchemy/bin/alchemy.js");
const fixtures = pathe.resolve(import.meta.dirname, "fixtures");

/**
 * The Effect release that was current when the published alchemy came out
 * (2026-10-05). Its peers accept `^4.0.0`, but later releases break it: 4.0.7
 * rejects a schema it builds (`Schema.optional` on an index signature) and 4.1
 * removed `effect/Crypto`, which it imports. Platform peers match: a platform
 * package from another release calls Effect APIs (e.g. `Path.make`) that the
 * other `effect` does not export.
 */
const PUBLISHED_EFFECT = "4.0.1";
const publishedPeers = {
  effect: PUBLISHED_EFFECT,
  "@effect/platform-node": PUBLISHED_EFFECT,
  "@effect/platform-bun": PUBLISHED_EFFECT,
  "@effect/platform-node-shared": PUBLISHED_EFFECT,
};

/**
 * Run a command to completion without blocking the runner's event loop.
 * Fails with the combined output on a non-zero exit.
 */
const run = (options: { cmd: string; args: string[]; cwd: string; env: Record<string, string> }) =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      // `CI=1` keeps both CLIs non-interactive.
      env: { ...process.env, ...options.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new Error(`${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

interface UpgradeCase {
  readonly framework: "Nuxt" | "Nextjs";
  readonly fixture: string;
  readonly entries: string[];
  /**
   * Where the temp project lives. Nuxt clones under the alchemy package so
   * `nuxt` resolves from the workspace; Next.js clones outside the repo
   * (OpenNext traces a monorepo's symlink store wrong) and installs its own
   * dependencies.
   */
  readonly tempRoot: string | undefined;
  readonly install: string[];
  /**
   * Peers the published alchemy needs, pinned to the Effect it was built for.
   */
  readonly peers?: Record<string, string>;
  readonly marker: string;
  /** State rows of the old Lambda Functions and their Web Function successors. */
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** State rows the upgrade removes without a successor. */
  readonly removed?: ReadonlyArray<string>;
}

const cases: UpgradeCase[] = [
  {
    framework: "Nuxt",
    fixture: "nuxt-app",
    entries: [".gitignore", "nuxt.config.ts", "app", "server", "public"],
    tempRoot: pathe.resolve(import.meta.dirname, "../../../.tmp"),
    // Peers (nuxt, astro, ...) resolve from the workspace above.
    install: ["install", "--omit", "peer"],
    peers: publishedPeers,
    marker: "NUXT_AWS_PAGE_MARKER",
    moved: [{ from: "Site__Server", to: "Site__WebServer" }],
  },
  {
    framework: "Nextjs",
    fixture: "nextjs-app",
    entries: [".gitignore", "package.json", "next.config.ts", "tsconfig.json", "app", "public"],
    tempRoot: undefined,
    install: ["install", "--linker=hoisted", "--omit", "peer"],
    peers: publishedPeers,
    marker: "NEXTJS_AWS_PAGE_MARKER",
    moved: [{ from: "Site__Server", to: "Site__WebServer" }],
    // Next's standalone server optimizes images and revalidates in-process.
    removed: [
      "Site__ImageOptimization",
      "Site__Revalidation",
      "Site__RevalidationQueue",
      "Site__TagCache",
    ],
  },
];

/** The stack program, valid for both versions. */
const stackProgram = (framework: string, alchemyImport: string, awsImport: string) =>
  [
    `import * as Alchemy from "${alchemyImport}";`,
    `import * as AWS from "${awsImport}";`,
    "",
    "export default Alchemy.Stack(",
    `  "${STACK}",`,
    "  { providers: AWS.providers(), state: Alchemy.localState() },",
    `  AWS.Website.${framework}("Site", {`,
    "    forceDestroy: true,",
    '    invalidation: { paths: "all", wait: true },',
    "  }),",
    ");",
    "",
  ].join("\n");

for (const upgrade of cases) {
  test.provider.skipIf(!!process.env.FAST)(
    `a ${upgrade.framework} site deployed by ${PUBLISHED} moves onto Web Functions and keeps its distribution`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Both CLIs read AWS credentials from the environment; under `CI=1`
        // the published one does not fall back to an SSO profile.
        const aws = yield* AWSEnvironment.current;
        const credentials = yield* aws.credentials;
        const awsEnv: Record<string, string> = {
          AWS_ACCESS_KEY_ID: Redacted.value(credentials.accessKeyId),
          AWS_SECRET_ACCESS_KEY: Redacted.value(credentials.secretAccessKey),
          ...(credentials.sessionToken
            ? { AWS_SESSION_TOKEN: Redacted.value(credentials.sessionToken) }
            : {}),
          AWS_REGION: aws.region,
        };

        const dir = yield* cloneFixture(path.join(fixtures, upgrade.fixture), {
          prefix: `alchemy-wf-upgrade-${upgrade.fixture}-`,
          tempRoot: upgrade.tempRoot,
          entries: upgrade.entries,
        });
        const stateFile = (fqn: string) =>
          // LocalState layout: .alchemy/state/<stack>/<stage>/<encodeFqn>.json
          path.join(dir, ".alchemy", "state", STACK, STAGE, `${fqn}.json`);
        const readRow = (fqn: string) =>
          fs.readFileString(stateFile(fqn)).pipe(Effect.map((raw) => JSON.parse(raw)));

        // Destroy whatever this attempt deployed even when a step fails. The
        // published CLI is the fallback for a state the current version
        // cannot load.
        const destroy = run({
          cmd: "bun",
          args: [workspaceCli, "destroy", "./alchemy.current.run.ts", "--stage", STAGE, "--yes"],
          cwd: dir,
          env: awsEnv,
        }).pipe(
          Effect.catch(() =>
            run({
              cmd: "bun",
              args: ["node_modules/alchemy/bin/cli.js", "destroy", "--stage", STAGE, "--yes"],
              cwd: dir,
              env: awsEnv,
            }),
          ),
        );
        const cleanup = destroy.pipe(
          Effect.ignore,
          Effect.andThen(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
        );

        yield* Effect.gen(function* () {
          // ── Fixture ───────────────────────────────────────────────────────
          // The fixture's own dependencies (if any) plus the published pair.
          const fixturePackage = yield* fs.readFileString(path.join(dir, "package.json")).pipe(
            Effect.map((raw) => JSON.parse(raw) as { dependencies?: Record<string, string> }),
            Effect.orElseSucceed(() => ({}) as { dependencies?: Record<string, string> }),
          );
          yield* fs.writeFileString(
            path.join(dir, "package.json"),
            JSON.stringify(
              {
                ...fixturePackage,
                name: "web-function-upgrade-fixture",
                private: true,
                type: "module",
                dependencies: {
                  ...fixturePackage.dependencies,
                  ...upgrade.peers,
                  alchemy: PUBLISHED,
                  "@alchemy.run/frontend-frameworks": PUBLISHED,
                },
                // Transitive platform packages must not float past them either.
                ...(upgrade.peers ? { overrides: upgrade.peers } : {}),
              },
              null,
              2,
            ),
          );
          yield* fs.writeFileString(
            path.join(dir, "alchemy.run.ts"),
            stackProgram(upgrade.framework, "alchemy", "alchemy/AWS"),
          );
          // Current-version entry: the WORKSPACE sources by absolute path.
          yield* fs.writeFileString(
            path.join(dir, "alchemy.current.run.ts"),
            stackProgram(
              upgrade.framework,
              pathe.join(repoRoot, "packages/alchemy/src/index.ts"),
              pathe.join(repoRoot, "packages/aws/src/index.ts"),
            ),
          );

          // Keep the stack entries out of the app's type-check: the current
          // one imports the whole workspace source.
          const tsconfigPath = path.join(dir, "tsconfig.json");
          if (yield* fs.exists(tsconfigPath)) {
            const tsconfig = JSON.parse(yield* fs.readFileString(tsconfigPath));
            yield* fs.writeFileString(
              tsconfigPath,
              JSON.stringify({
                ...tsconfig,
                exclude: [...(tsconfig.exclude ?? []), "alchemy.run.ts", "alchemy.current.run.ts"],
              }),
            );
          }

          // ── Phase 1: deploy with the published version ────────────────────
          yield* run({ cmd: "bun", args: upgrade.install, cwd: dir, env: awsEnv });
          yield* run({
            cmd: "bun",
            args: ["node_modules/alchemy/bin/cli.js", "deploy", "--stage", STAGE, "--yes"],
            cwd: dir,
            env: awsEnv,
          });

          for (const { from } of upgrade.moved) {
            expect((yield* readRow(from)).attr.functionUrl).toContain(".lambda-url.");
          }
          for (const row of upgrade.removed ?? []) {
            expect(yield* fs.exists(stateFile(row))).toBe(true);
          }
          const before = yield* readRow("Site__Distribution");
          const distributionId: string = before.attr.distributionId;
          const siteUrl = `https://${before.attr.domainName}`;
          yield* expectUrlContains(`${siteUrl}/`, upgrade.marker, {
            timeout: "180 seconds",
            label: "SSR page from the published version",
          });

          // ── Phase 2: re-deploy with the CURRENT workspace version ─────────
          // The upgrade a user runs bumps both packages together.
          const linked = path.join(dir, "node_modules", "@alchemy.run", "frontend-frameworks");
          yield* fs.remove(linked, { recursive: true });
          yield* fs.symlink(path.join(repoRoot, "packages/frontend-frameworks"), linked);
          yield* run({
            cmd: "bun",
            args: [workspaceCli, "deploy", "./alchemy.current.run.ts", "--stage", STAGE, "--yes"],
            cwd: dir,
            env: awsEnv,
          });

          // Each server moved onto a Web Function and the old function is gone.
          for (const { from, to } of upgrade.moved) {
            expect((yield* readRow(to)).attr.domainName).toContain(".lambda-web.");
            expect(yield* fs.exists(stateFile(from))).toBe(false);
          }
          for (const row of upgrade.removed ?? []) {
            expect(yield* fs.exists(stateFile(row))).toBe(false);
          }

          // THE assertion: same distribution, same URL, still serving.
          const after = yield* readRow("Site__Distribution");
          expect(after.attr.distributionId).toEqual(distributionId);
          yield* expectUrlContains(`${siteUrl}/`, upgrade.marker, {
            timeout: "180 seconds",
            label: "SSR page after the upgrade",
          });

          // ── Cleanup ───────────────────────────────────────────────────────
          yield* destroy;
          yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
            Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
            Effect.catchTag("NoSuchDistribution", () => Effect.void),
            Effect.retry({
              while: (error) =>
                error instanceof Error && error.message === "DistributionStillExists",
              schedule: Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)]),
            }),
          );
        }).pipe(Effect.ensuring(cleanup));
      }),
    {
      tags: ["provider:aws", "provider:aws:cloudfront", "provider:aws:website", "live"],
      timeout: 2_400_000,
    },
  );
}
