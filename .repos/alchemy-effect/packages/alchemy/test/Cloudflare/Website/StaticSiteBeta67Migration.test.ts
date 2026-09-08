/**
 * Cross-version FQN-migration regression test for the beta.68 StaticSite
 * incident (#1053 / #1108).
 *
 * A temp project deploys a StaticSite with the PUBLISHED alchemy@2.0.0-beta.67
 * (whose StaticSite persists its Worker at the `<id>/Worker` FQN), then the
 * CURRENT workspace version re-deploys over the same local state. The
 * `renamedFrom(`${id}/Worker`)` migration must move the state row to `<id>`
 * and re-brand the worker in place — the worker must NOT be deleted or
 * recreated.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawn } from "node:child_process";
import * as pathe from "pathe";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const repoRoot = pathe.resolve(import.meta.dirname, "../../../../..");
const workspaceCli = pathe.join(repoRoot, "packages/alchemy/bin/alchemy.ts");

const STACK = "B67MigrationTest";
const STAGE = "b67mig";

/**
 * Run a command to completion without blocking the runner's event loop
 * (the suite shares one bun process; a sync spawn would stall every
 * concurrently running test). Fails with the combined output on a
 * non-zero exit.
 */
const run = (options: {
  cmd: string;
  args: string[];
  cwd: string;
}): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
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
              new Error(
                `${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`,
              ),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

/** The stack program, valid for both beta.67 and the current version. */
const stackProgram = (alchemyImport: string, cloudflareImport: string) =>
  [
    `import * as Alchemy from "${alchemyImport}";`,
    `import * as Cloudflare from "${cloudflareImport}";`,
    "",
    "export default Alchemy.Stack(",
    `  "${STACK}",`,
    "  { providers: Cloudflare.providers(), state: Alchemy.localState() },",
    // A pure-static site: no `main`, no bundling — the smallest surface
    // that exists identically in both versions.
    '  Cloudflare.Website.StaticSite("Site", {',
    '    command: "bash build.sh",',
    '    outdir: "dist",',
    "  }),",
    ");",
    "",
  ].join("\n");

test.provider.skipIf(!!process.env.FAST)(
  "a beta.67 StaticSite migrates to the current version without recreating the worker",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { accountId } = yield* yield* CloudflareEnvironment;

      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-b67-mig-" });
      const stateFile = (fqn: string) =>
        // LocalState layout: .alchemy/state/<stack>/<stage>/<encodeFqn>.json
        path.join(dir, ".alchemy", "state", STACK, STAGE, `${fqn}.json`);
      const readRow = (fqn: string) =>
        fs
          .readFileString(stateFile(fqn))
          .pipe(Effect.map((raw) => JSON.parse(raw)));

      // ── Fixture ─────────────────────────────────────────────────────────
      yield* fs.writeFileString(
        path.join(dir, "package.json"),
        JSON.stringify(
          {
            name: "b67-migration-fixture",
            private: true,
            dependencies: {
              alchemy: "2.0.0-beta.67",
              // beta.67's peers, pinned to the workspace's resolved
              // versions (bun does not auto-install them for the src/
              // resolution path the alchemy CLI runs under).
              effect: "4.0.0-beta.102",
              "@effect/platform-node": "4.0.0-beta.102",
              "@effect/platform-bun": "4.0.0-beta.102",
            },
          },
          null,
          2,
        ),
      );
      yield* fs.writeFileString(
        path.join(dir, "index.html"),
        "<h1>b67-migration</h1>",
      );
      yield* fs.writeFileString(
        path.join(dir, "build.sh"),
        "mkdir -p dist && cp index.html dist/index.html",
      );
      // beta.67 entry: resolves `alchemy` from the temp node_modules.
      yield* fs.writeFileString(
        path.join(dir, "alchemy.run.ts"),
        stackProgram("alchemy", "alchemy/Cloudflare"),
      );
      // Current-version entry: resolves the WORKSPACE sources directly, so
      // no linking dance is needed and `effect` is the workspace instance.
      yield* fs.writeFileString(
        path.join(dir, "alchemy.current.run.ts"),
        stackProgram(
          pathe.join(repoRoot, "packages/alchemy/src/index.ts"),
          pathe.join(repoRoot, "packages/alchemy/src/Cloudflare/index.ts"),
        ),
      );

      // ── Phase 1: deploy with the published beta.67 ──────────────────────
      yield* run({ cmd: "bun", args: ["install"], cwd: dir });
      yield* run({
        cmd: "bun",
        args: [
          "node_modules/alchemy/bin/cli.js",
          "deploy",
          "--stage",
          STAGE,
          "--yes",
        ],
        cwd: dir,
      });

      // beta.67 persisted the Worker at the legacy `Site/Worker` FQN.
      const before = yield* readRow("Site__Worker");
      const workerName: string = before.attr.workerName;
      expect(before.fqn).toEqual("Site/Worker");
      expect(workerName).toBeDefined();
      yield* expectWorkerExists(workerName, accountId);

      // ── Phase 2: re-deploy with the CURRENT workspace version ───────────
      const output = yield* run({
        cmd: "bun",
        args: [
          workspaceCli,
          "deploy",
          "./alchemy.current.run.ts",
          "--stage",
          STAGE,
          "--yes",
        ],
        cwd: dir,
      });

      // The plan surfaced the migration and never planned a create/delete.
      expect(output).toContain("renamed from Site/Worker");
      expect(output).not.toContain("to create");
      expect(output).not.toContain("to delete");

      // The row moved: same instanceId, same physical worker, new FQN.
      const after = yield* readRow("Site");
      expect(after.instanceId).toEqual(before.instanceId);
      expect(after.attr.workerName).toEqual(workerName);
      expect(after.logicalId).toEqual("Site");
      expect(yield* fs.exists(stateFile("Site__Worker"))).toBe(false);

      // THE assertion: the worker survived the upgrade.
      yield* expectWorkerExists(workerName, accountId);

      // ── Cleanup ─────────────────────────────────────────────────────────
      yield* run({
        cmd: "bun",
        args: [
          workspaceCli,
          "destroy",
          "./alchemy.current.run.ts",
          "--stage",
          STAGE,
          "--yes",
        ],
        cwd: dir,
      });
      yield* waitForWorkerToBeDeleted(workerName, accountId);
      yield* fs.remove(dir, { recursive: true });
    }),
  { timeout: 600_000 },
);
