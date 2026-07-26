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

const scriptPath = NodeURL.fileURLToPath(new URL("./setup-worktree.sh", import.meta.url));

const lockContents = "lockfileVersion: '9.0'\n";

const sh = (command: string, cwd: string) =>
  NodeChildProcess.execFileSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });

/**
 * A throwaway checkout: a real git repo with the two files the script reads,
 * plus a `pnpm` stub on PATH so the install path can be asserted without
 * actually resolving a dependency graph.
 */
function makeRepo(options: { readonly upstreamRemote?: boolean } = {}): string {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "setup-worktree-"));
  NodeFS.mkdirSync(NodePath.join(repo, "scripts"));
  NodeFS.copyFileSync(scriptPath, NodePath.join(repo, "scripts", "setup-worktree.sh"));
  NodeFS.chmodSync(NodePath.join(repo, "scripts", "setup-worktree.sh"), 0o755);
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    `${JSON.stringify({ name: "fixture", engines: { node: "^24.13.1" } }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(repo, "pnpm-lock.yaml"), lockContents);

  const stubBin = NodePath.join(repo, "stub-bin");
  NodeFS.mkdirSync(stubBin);
  NodeFS.writeFileSync(NodePath.join(stubBin, "pnpm"), '#!/bin/sh\necho "stub pnpm $*"\nexit 0\n');
  NodeFS.chmodSync(NodePath.join(stubBin, "pnpm"), 0o755);

  sh("git init -q -b main", repo);
  sh("git config user.email fixture@example.com", repo);
  sh("git config user.name Fixture", repo);
  sh(
    options.upstreamRemote === true
      ? "git remote add origin https://github.com/pingdotgg/t3code.git"
      : "git remote add origin https://github.com/SergeSerb2/SergeCode.git",
    repo,
  );
  return repo;
}

/** Record a successful install for the current lockfile, as the script would. */
function seedInstall(repo: string): void {
  NodeFS.mkdirSync(NodePath.join(repo, "node_modules"), { recursive: true });
  const hash = sh("shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1", repo).trim();
  NodeFS.writeFileSync(NodePath.join(repo, "node_modules", ".sergecode-setup-lock-hash"), hash);
}

const runIn = (repo: string, args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(NodePath.join(repo, "scripts", "setup-worktree.sh"), args, {
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

const withRepo = <A, E, R>(
  options: { readonly upstreamRemote?: boolean },
  use: (repo: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeRepo(options)),
    use,
    (repo) => Effect.sync(() => NodeFS.rmSync(repo, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("setup-worktree.sh", (it) => {
  it.effect("does nothing when the install already matches the lockfile", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        const result = yield* runIn(repo);
        assert.strictEqual(result.exitCode, 0);
        assert.include(result.output, "already match pnpm-lock.yaml");
        assert.notInclude(result.output, "installing dependencies");
      }),
    ),
  );

  it.effect("installs when node_modules is missing, as in a fresh worktree", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        const result = yield* runIn(repo);
        assert.strictEqual(result.exitCode, 0);
        assert.include(result.output, "installing dependencies");
        assert.include(result.output, "stub pnpm install --frozen-lockfile");
        assert.include(result.output, "dependencies ready");
      }),
    ),
  );

  it.effect("reinstalls when the lockfile moved since the last install", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        NodeFS.writeFileSync(
          NodePath.join(repo, "pnpm-lock.yaml"),
          `${lockContents}# a dependency changed\n`,
        );
        const result = yield* runIn(repo);
        assert.strictEqual(result.exitCode, 0);
        assert.include(result.output, "installing dependencies");
      }),
    ),
  );

  it.effect("--force reinstalls even when nothing changed", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        const result = yield* runIn(repo, ["--force"]);
        assert.strictEqual(result.exitCode, 0);
        assert.include(result.output, "installing dependencies");
      }),
    ),
  );

  it.effect("refuses to run when a remote points at the upstream repo", () =>
    withRepo({ upstreamRemote: true }, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        const result = yield* runIn(repo);
        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "pingdotgg/t3code");
      }),
    ),
  );

  it.effect("rejects unknown arguments instead of guessing", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        const result = yield* runIn(repo, ["--reinstall-everything"]);
        assert.notStrictEqual(result.exitCode, 0);
        assert.include(result.output, "Usage:");
      }),
    ),
  );

  it.effect("warns when the active node major does not match engines", () =>
    withRepo({}, (repo) =>
      Effect.gen(function* () {
        seedInstall(repo);
        const result = yield* runIn(repo);
        const activeMajor = process.versions.node.split(".")[0];
        if (activeMajor === "24") {
          assert.notInclude(result.output, "package.json wants");
        } else {
          assert.include(result.output, "package.json wants v24.x");
        }
      }),
    ),
  );
});
