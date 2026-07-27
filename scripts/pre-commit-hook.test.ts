// @effect-diagnostics nodeBuiltinImport:off
// The fixture builds a throwaway git repo on disk before any Effect runtime
// exists, so the synchronous node APIs are the right tool here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const hookPath = NodeURL.fileURLToPath(new URL("../.vite-hooks/pre-commit", import.meta.url));
const setupPath = NodeURL.fileURLToPath(new URL("./setup-worktree.sh", import.meta.url));

const sh = (command: string, cwd: string) =>
  NodeChildProcess.execFileSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });

interface Fixture {
  /** Body of the `pnpm` stub, which stands in for the bootstrap's install. */
  readonly pnpmStub?: string;
  /** Pretend the worktree is already bootstrapped. */
  readonly bootstrapped?: boolean;
  /** Ship the repo without a usable setup script. */
  readonly withoutSetupScript?: boolean;
}

/**
 * A worktree-shaped repo: the hook, the setup script it delegates to, and a
 * `vp` stub that records whether the real check ever ran.
 */
function makeRepo(options: Fixture = {}): string {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pre-commit-hook-"));
  NodeFS.mkdirSync(NodePath.join(repo, "scripts"));
  NodeFS.copyFileSync(hookPath, NodePath.join(repo, "pre-commit"));
  NodeFS.chmodSync(NodePath.join(repo, "pre-commit"), 0o755);
  if (options.withoutSetupScript !== true) {
    NodeFS.copyFileSync(setupPath, NodePath.join(repo, "scripts", "setup-worktree.sh"));
    NodeFS.chmodSync(NodePath.join(repo, "scripts", "setup-worktree.sh"), 0o755);
  }
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    `${JSON.stringify({ name: "fixture", engines: { node: "^24.13.1" } }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const stubBin = NodePath.join(repo, "stub-bin");
  NodeFS.mkdirSync(stubBin);
  NodeFS.writeFileSync(
    NodePath.join(stubBin, "pnpm"),
    options.pnpmStub ?? '#!/bin/sh\nmkdir -p node_modules/vite-plus\necho "stub pnpm $*"\n',
  );
  NodeFS.chmodSync(NodePath.join(stubBin, "pnpm"), 0o755);
  NodeFS.writeFileSync(
    NodePath.join(stubBin, "vp"),
    `#!/bin/sh\nprintf ran > '${NodePath.join(repo, "vp-staged-ran")}'\n`,
  );
  NodeFS.chmodSync(NodePath.join(stubBin, "vp"), 0o755);

  if (options.bootstrapped === true) {
    NodeFS.mkdirSync(NodePath.join(repo, "node_modules", "vite-plus"), { recursive: true });
  }

  sh("git init -q -b main", repo);
  sh("git remote add origin https://github.com/SergeSerb2/SergeCode.git", repo);
  return repo;
}

const stagedCheckRan = (repo: string): boolean =>
  NodeFS.existsSync(NodePath.join(repo, "vp-staged-ran"));

/** Run the hook the way `.vite-hooks/_/h` does: `sh -e`, worktree as cwd. */
const runHook = (repo: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-e", NodePath.join(repo, "pre-commit")], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${NodePath.join(repo, "stub-bin")}:${process.env["PATH"] ?? ""}`,
        },
      }),
    );
    const collect = (stream: typeof child.stdout) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (accumulated: string, chunk: string) => accumulated + chunk,
        ),
      );
    const stdout = yield* collect(child.stdout);
    const stderr = yield* collect(child.stderr);
    const exitCode = Number(yield* child.exitCode);
    return { exitCode, output: `${stdout}${stderr}` };
  });

const withRepo = <A, E, R>(options: Fixture, use: (repo: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeRepo(options)),
    use,
    (repo) => Effect.sync(() => NodeFS.rmSync(repo, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)(".vite-hooks/pre-commit", (it) => {
  it.effect("runs the staged check when the worktree is already bootstrapped", () =>
    withRepo({ bootstrapped: true }, (repo) =>
      Effect.gen(function* () {
        const result = yield* runHook(repo);
        assert.strictEqual(result.exitCode, 0);
        assert.isTrue(stagedCheckRan(repo), "vp staged should have run");
      }),
    ),
  );

  it.effect("bootstraps an unbootstrapped worktree and then still runs the check", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        const result = yield* runHook(repo);
        assert.strictEqual(result.exitCode, 0);
        assert.include(result.output, "bootstrapping it first");
        // The whole point: the gate is not skipped, so the commit that
        // triggered the bootstrap is formatted like any other.
        assert.isTrue(stagedCheckRan(repo), "vp staged should have run after bootstrap");
      }),
    ),
  );

  it.effect("fails closed when the bootstrap fails, rather than waving the commit through", () =>
    withRepo({ pnpmStub: '#!/bin/sh\necho "registry unreachable" >&2\nexit 7\n' }, (repo) =>
      Effect.gen(function* () {
        const result = yield* runHook(repo);
        assert.notStrictEqual(result.exitCode, 0);
        assert.isFalse(stagedCheckRan(repo), "vp staged must not run on a broken worktree");
        assert.include(result.output, "Bootstrap failed");
        // A closed gate is only acceptable if the way out is stated.
        assert.include(result.output, "pnpm run setup");
        assert.include(result.output, "VITE_GIT_HOOKS=0");
      }),
    ),
  );

  it.effect("fails closed when there is no setup script to bootstrap with", () =>
    withRepo({ withoutSetupScript: true }, (repo) =>
      Effect.gen(function* () {
        const result = yield* runHook(repo);
        assert.notStrictEqual(result.exitCode, 0);
        assert.isFalse(stagedCheckRan(repo));
        assert.include(result.output, "setup-worktree.sh is missing");
        assert.include(result.output, "VITE_GIT_HOOKS=0");
      }),
    ),
  );
});
