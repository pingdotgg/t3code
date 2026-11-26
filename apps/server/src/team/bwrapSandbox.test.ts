// @effect-diagnostics nodeBuiltinImport:off -- Uses mkdtemp/chmod/symlink/spawnSync to test canonical path resolution, git worktrees, and optional real bwrap execution.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { makeAcpClientTerminals } from "@t3tools/provider-acp/server/clientTerminals";
import { AgentScope, ProcessSandbox } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  buildBwrapArgs,
  buildBwrapProbeArgs,
  checkBwrapAvailability,
  classifyBwrapProbeFailure,
  extractSandboxBindsFromEnvAndArgs,
  isBwrapSandboxPathError,
  isBwrapSandboxUnavailableError,
  make as makeBwrapProcessSandbox,
  wrapCommandWithBwrap,
} from "./bwrapSandbox.ts";

function makeProcessOutput(
  stdout: string,
  stderr = "",
  code = 0,
  timedOut = false,
): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

function makeTempFixtureDir(prefix: string): string {
  return NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
}

function detectRealBwrapBinary(): string | null {
  if (HostProcess.Platform.defaultValue() !== "linux") return null;
  const which = NodeChildProcess.spawnSync("which", ["bwrap"], { encoding: "utf8" });
  if (which.status !== 0) return null;
  const binary = which.stdout.trim();
  if (binary.length === 0) return null;
  const probe = NodeChildProcess.spawnSync(binary, [...buildBwrapProbeArgs()], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return probe.status === 0 ? binary : null;
}

const REAL_BWRAP_BINARY = detectRealBwrapBinary();

describe("bwrapSandbox pure helpers", () => {
  it("builds namespace, OS ro-binds, isolated /tmp before /tmp binds, and worktree masks", () => {
    const args = buildBwrapArgs({
      bwrapBinaryPath: "/usr/bin/bwrap",
      cwd: "/tmp/t3-workspaces/wt-alice",
      chdir: "/tmp/t3-workspaces/wt-alice",
      gitWorktree: {
        commonDir: "/srv/repos/app/.git",
        worktreeGitDir: "/srv/repos/app/.git/worktrees/wt-alice",
        maskWorktreesDir: "/srv/repos/app/.git/worktrees",
      },
      providerProfileDirs: [
        "/var/lib/t3runner/userdata/team-profiles/codex/abc123",
        "/var/lib/t3runner/userdata/team-profiles/codex/abc123",
      ],
      toolCacheDirs: ["/var/cache/t3-tools/pnpm"],
      extraRwBinds: ["/tmp/t3-turn-1/gh-config"],
      extraRoBinds: ["/usr/bin/node", "/opt/custom/bin/tool", "/var/lib/t3runner/tools/codex"],
      socketPaths: ["/tmp/t3-token-123/s"],
      helperPaths: ["/tmp/t3-turn-1/askpass.sh"],
      command: "/var/lib/t3runner/tools/codex",
      args: ["app-server"],
    });

    expect(args.slice(0, 5)).toEqual([
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
    ]);

    expect(args).toContain("--ro-bind");
    expect(args).toContain("/usr");
    expect(args).toContain("--ro-bind-try");
    expect(args).toContain("/etc");
    expect(args).toContain("/run/systemd/resolve");
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");

    const tmpfsIdx = args.indexOf("--tmpfs");
    const cwdBindIdx = args.indexOf("/tmp/t3-workspaces/wt-alice");
    const socketIdx = args.indexOf("/tmp/t3-token-123/s");
    const helperIdx = args.indexOf("/tmp/t3-turn-1/askpass.sh");
    expect(tmpfsIdx).toBeGreaterThan(-1);
    expect(args[tmpfsIdx + 1]).toBe("/tmp");
    expect(cwdBindIdx).toBeGreaterThan(tmpfsIdx);
    expect(socketIdx).toBeGreaterThan(tmpfsIdx);
    expect(helperIdx).toBeGreaterThan(tmpfsIdx);

    // Linked git common-dir masks sibling .git/worktrees/* via tmpfs then re-binds only wt-alice.
    const commonIdx = args.indexOf("/srv/repos/app/.git");
    const maskIdx = args.indexOf("/srv/repos/app/.git/worktrees");
    const wtGitIdx = args.indexOf("/srv/repos/app/.git/worktrees/wt-alice");
    expect(commonIdx).toBeGreaterThan(-1);
    expect(maskIdx).toBeGreaterThan(commonIdx);
    expect(args[maskIdx - 1]).toBe("--tmpfs");
    expect(wtGitIdx).toBeGreaterThan(maskIdx);
    expect(args[wtGitIdx - 1]).toBe("--bind");

    // Deduplicated profile bind and already-covered OS binds (/usr, /opt) are not duplicated.
    const profileOccurrences = args.filter(
      (entry) => entry === "/var/lib/t3runner/userdata/team-profiles/codex/abc123",
    );
    expect(profileOccurrences).toHaveLength(2); // single --bind <src> <dst> pair
    expect(args).not.toContain("/usr/bin/node");
    expect(args).not.toContain("/opt/custom/bin/tool");
    expect(args).toContain("/var/lib/t3runner/tools/codex");

    const separatorIdx = args.indexOf("--");
    expect(args.slice(separatorIdx - 2)).toEqual([
      "--chdir",
      "/tmp/t3-workspaces/wt-alice",
      "--",
      "/var/lib/t3runner/tools/codex",
      "app-server",
    ]);
  });

  it("extracts isolated profiles, turn helpers, GH_CONFIG_DIR, and broker sockets from env and args", () => {
    const extracted = extractSandboxBindsFromEnvAndArgs(
      {
        GEMINI_HOME: "/var/lib/t3runner/userdata/providers/antigravity/hash1",
        CODEX_HOME: "/var/lib/t3runner/userdata/team-profiles/codex/hash2",
        CLAUDE_CONFIG_DIR: "/var/lib/t3runner/userdata/team-profiles/claudeAgent/hash3",
        GIT_ASKPASS: "/tmp/t3-turn-a/askpass.sh",
        GH_CONFIG_DIR: "/tmp/t3-turn-a/gh",
        T3_GITHUB_BROKER_SOCKET: "/tmp/t3-turn-a/gh.sock",
        T3_ACP_MCP_NODE: "/var/lib/t3runner/tools/node",
        T3_ACP_MCP_ENTRYPOINT: "/var/lib/t3runner/tools/bin.mjs",
      },
      [
        "-c",
        'model_providers.openai_token_sharing={auth={command="/usr/bin/node",args=["__managed-chatgpt-token","/tmp/t3-token-abc/s","inst-1"]}}',
      ],
    );

    expect(extracted.providerProfileDirs).toEqual([
      "/var/lib/t3runner/userdata/providers/antigravity/hash1",
      "/var/lib/t3runner/userdata/team-profiles/codex/hash2",
      "/var/lib/t3runner/userdata/team-profiles/claudeAgent/hash3",
    ]);
    expect(extracted.helperRoPaths).toEqual([
      "/tmp/t3-turn-a/askpass.sh",
      "/var/lib/t3runner/tools/node",
      "/var/lib/t3runner/tools/bin.mjs",
    ]);
    expect(extracted.helperRwDirs).toEqual(["/tmp/t3-turn-a/gh"]);
    expect(extracted.socketPaths).toEqual(["/tmp/t3-turn-a/gh.sock", "/tmp/t3-token-abc/s"]);
  });

  it("classifies user-namespace and AppArmor probe stderr accurately", () => {
    expect(classifyBwrapProbeFailure("bwrap: setting up uid map: Permission denied")).toBe(
      "userns_unavailable",
    );
    expect(
      classifyBwrapProbeFailure("bwrap: No permissions to creating new namespace, likely AppArmor"),
    ).toBe("userns_unavailable");
    expect(
      classifyBwrapProbeFailure("bwrap: Creating new namespace failed: Operation not permitted"),
    ).toBe("userns_unavailable");
    expect(classifyBwrapProbeFailure("bwrap: unexpected segfault")).toBe("probe_failed");
  });
});

it.layer(NodeServices.layer)("bwrapSandbox validation, worktrees & fail-closed preflight", (it) => {
  it.effect("resolves linked git worktree common-dir while excluding sibling worktrees", () =>
    Effect.gen(function* () {
      const root = makeTempFixtureDir("t3-bwrap-wt-");
      try {
        const ownStateDir = NodePath.join(root, "runner", "userdata");
        NodeFS.mkdirSync(ownStateDir, { recursive: true });

        // Simulate a main repo + two linked worktrees (wt-alice and wt-bob).
        const mainRepo = NodePath.join(root, "repos", "main");
        const mainGitDir = NodePath.join(mainRepo, ".git");
        const wtAliceGitDir = NodePath.join(mainGitDir, "worktrees", "wt-alice");
        const wtBobGitDir = NodePath.join(mainGitDir, "worktrees", "wt-bob");
        NodeFS.mkdirSync(NodePath.join(mainGitDir, "objects"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(mainGitDir, "HEAD"), "ref: refs/heads/main\n");
        NodeFS.mkdirSync(wtAliceGitDir, { recursive: true });
        NodeFS.mkdirSync(wtBobGitDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(wtAliceGitDir, "commondir"), "../..\n");
        NodeFS.writeFileSync(NodePath.join(wtBobGitDir, "commondir"), "../..\n");

        const wtAlice = NodePath.join(root, "worktrees", "wt-alice");
        const wtBob = NodePath.join(root, "worktrees", "wt-bob");
        NodeFS.mkdirSync(wtAlice, { recursive: true });
        NodeFS.mkdirSync(wtBob, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(wtAlice, ".git"), `gitdir: ${wtAliceGitDir}\n`);
        NodeFS.writeFileSync(NodePath.join(wtBob, ".git"), `gitdir: ${wtBobGitDir}\n`);

        const wrapped = yield* wrapCommandWithBwrap({
          bwrapBinaryPath: "/usr/bin/bwrap",
          command: "/bin/sh",
          args: ["-c", "git status"],
          cwd: wtAlice,
          ownStateDir,
        });

        expect(wrapped.command).toBe("/usr/bin/bwrap");
        expect(wrapped.args).toContain(wtAlice);
        expect(wrapped.args).toContain(mainGitDir);
        expect(wrapped.args).toContain(wtAliceGitDir);
        // Never mounts main repo working tree, sibling wt-bob working tree, or sibling wt-bob gitdir.
        expect(wrapped.args).not.toContain(mainRepo);
        expect(wrapped.args).not.toContain(wtBob);
        expect(wrapped.args).not.toContain(wtBobGitDir);
        const maskIdx = wrapped.args.indexOf(NodePath.join(mainGitDir, "worktrees"));
        expect(maskIdx).toBeGreaterThan(-1);
        expect(wrapped.args[maskIdx - 1]).toBe("--tmpfs");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not add extra git binds for a regular repo with a .git directory", () =>
    Effect.gen(function* () {
      const root = makeTempFixtureDir("t3-bwrap-regular-git-");
      try {
        const repoDir = NodePath.join(root, "repo");
        NodeFS.mkdirSync(NodePath.join(repoDir, ".git", "objects"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

        const wrapped = yield* wrapCommandWithBwrap({
          bwrapBinaryPath: "/usr/bin/bwrap",
          command: "/bin/sh",
          args: ["-c", "true"],
          cwd: repoDir,
        });

        const bindTargets = wrapped.args.filter((_, idx) => wrapped.args[idx - 1] === "--bind");
        expect(bindTargets).toEqual([repoDir]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "rejects forbidden userdata, ancestor, non-absolute, NUL, and symlink escape binds",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-reject-");
        try {
          const runnerBase = NodePath.join(root, "t3runner");
          const ownStateDir = NodePath.join(runnerBase, "userdata");
          const secretsDir = NodePath.join(ownStateDir, "secrets");
          const sqlitePath = NodePath.join(ownStateDir, "statev2.sqlite");
          const teamProfilesParent = NodePath.join(ownStateDir, "team-profiles", "codex");
          const isolatedCodexProfile = NodePath.join(teamProfilesParent, "profile-abc");
          const hubBase = NodePath.join(root, "t3hub");
          const hubUserdata = NodePath.join(hubBase, "userdata");
          const validCwd = NodePath.join(runnerBase, "worktrees", "wt-alice");

          NodeFS.mkdirSync(secretsDir, { recursive: true });
          NodeFS.writeFileSync(sqlitePath, "sqlite");
          NodeFS.mkdirSync(isolatedCodexProfile, { recursive: true });
          NodeFS.mkdirSync(hubUserdata, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(hubUserdata, "statev2.sqlite"), "hub-db");
          NodeFS.mkdirSync(validCwd, { recursive: true });

          const expectPathFailure = (
            input: Parameters<typeof wrapCommandWithBwrap>[0],
            expectedReason: string,
          ) =>
            Effect.gen(function* () {
              const result = yield* Effect.result(wrapCommandWithBwrap(input));
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result)) {
                expect(isBwrapSandboxPathError(result.failure)).toBe(true);
                if (isBwrapSandboxPathError(result.failure)) {
                  expect(result.failure.reason).toBe(expectedReason);
                }
              }
            });

          // Relative and NUL paths fail closed.
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: "relative/worktree",
              ownStateDir,
            },
            "non_absolute",
          );
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: `${validCwd}\0evil`,
              ownStateDir,
            },
            "nul_byte",
          );

          // Runner userdata root, ancestor baseDir, secrets, and statev2.sqlite are all refused.
          for (const forbidden of [runnerBase, ownStateDir, secretsDir, sqlitePath]) {
            yield* expectPathFailure(
              {
                bwrapBinaryPath: "/usr/bin/bwrap",
                command: "/bin/sh",
                args: [],
                cwd: validCwd,
                ownStateDir,
                extraRwBinds: [forbidden],
              },
              "forbidden_userdata_path",
            );
          }

          // Hub userdata and parent profile directories are refused even as providerProfileDirs.
          for (const badProfile of [
            ownStateDir,
            secretsDir,
            NodePath.join(ownStateDir, "team-profiles"),
            teamProfilesParent,
            hubUserdata,
          ]) {
            yield* expectPathFailure(
              {
                bwrapBinaryPath: "/usr/bin/bwrap",
                command: "/bin/sh",
                args: [],
                cwd: validCwd,
                ownStateDir,
                forbiddenUserdataDirs: [hubBase, hubUserdata],
                providerProfileDirs: [badProfile],
              },
              "forbidden_userdata_path",
            );
          }

          // Isolated leaf provider profile under ownStateDir IS allowed as providerProfileDir...
          const allowed = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: [],
            cwd: validCwd,
            ownStateDir,
            forbiddenUserdataDirs: [hubBase, hubUserdata],
            env: { CODEX_HOME: isolatedCodexProfile },
          });
          expect(allowed.args).toContain(isolatedCodexProfile);
          expect(allowed.args).not.toContain(ownStateDir);

          // ...but NEVER allowed as cwd or extraRwBinds.
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: isolatedCodexProfile,
              ownStateDir,
            },
            "forbidden_userdata_path",
          );

          // chdir escaping workspace fails closed.
          const outsideDir = NodePath.join(root, "outside");
          NodeFS.mkdirSync(outsideDir, { recursive: true });
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              chdir: outsideDir,
              ownStateDir,
            },
            "chdir_outside_workspace",
          );

          // Malicious .git file pointing into userdata or non-git directory fails closed.
          const maliciousWt = NodePath.join(runnerBase, "worktrees", "wt-evil");
          NodeFS.mkdirSync(maliciousWt, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(maliciousWt, ".git"), `gitdir: ${ownStateDir}\n`);
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: maliciousWt,
              ownStateDir,
            },
            "forbidden_userdata_path",
          );

          NodeFS.writeFileSync(NodePath.join(maliciousWt, ".git"), `gitdir: ${outsideDir}\n`);
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: maliciousWt,
              ownStateDir,
            },
            "invalid_git_worktree",
          );

          // Symlink pointing into runner userdata is resolved via realpath and refused.
          if (symlinksSupported) {
            const symlinkEscape = NodePath.join(root, "innocent-link");
            NodeFS.symlinkSync(secretsDir, symlinkEscape);
            yield* expectPathFailure(
              {
                bwrapBinaryPath: "/usr/bin/bwrap",
                command: "/bin/sh",
                args: [],
                cwd: validCwd,
                ownStateDir,
                extraRwBinds: [symlinkEscape],
              },
              "forbidden_userdata_path",
            );
          }
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect("preflight fails closed on non-Linux, missing binary, and blocked userns", () =>
    Effect.gen(function* () {
      const binDir = makeTempFixtureDir("t3-bwrap-preflight-");
      try {
        const fakeBwrap = NodePath.join(binDir, "bwrap");
        NodeFS.writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

        const noopRunner = ProcessRunner.ProcessRunner.of({
          run: () => Effect.succeed(makeProcessOutput("")),
        });

        // Non-Linux fails closed with unsupported_platform.
        const darwinResult = yield* Effect.result(
          checkBwrapAvailability().pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, noopRunner),
          ),
        );
        expect(Result.isFailure(darwinResult)).toBe(true);
        if (Result.isFailure(darwinResult)) {
          expect(isBwrapSandboxUnavailableError(darwinResult.failure)).toBe(true);
          expect(darwinResult.failure.reason).toBe("unsupported_platform");
        }

        // Missing binary fails closed with binary_not_found.
        const emptyDir = NodePath.join(binDir, "empty");
        NodeFS.mkdirSync(emptyDir);
        const missingResult = yield* Effect.result(
          checkBwrapAvailability().pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: emptyDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, noopRunner),
          ),
        );
        expect(Result.isFailure(missingResult)).toBe(true);
        if (Result.isFailure(missingResult)) {
          expect(missingResult.failure.reason).toBe("binary_not_found");
        }

        // AppArmor / userns restriction fails closed with userns_unavailable.
        const blockedRunner = ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.succeed(
              makeProcessOutput("", "bwrap: setting up uid map: Permission denied", 1),
            ),
        });
        const blockedResult = yield* Effect.result(
          checkBwrapAvailability().pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, blockedRunner),
          ),
        );
        expect(Result.isFailure(blockedResult)).toBe(true);
        if (Result.isFailure(blockedResult)) {
          expect(blockedResult.failure.reason).toBe("userns_unavailable");
          expect(blockedResult.failure.message).toContain("AppArmor");
        }

        // Successful Linux probe returns resolved bwrap binary path.
        const ok = yield* checkBwrapAvailability().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { PATH: binDir }),
          Effect.provideService(ProcessRunner.ProcessRunner, noopRunner),
        );
        expect(ok).toEqual({ available: true, binaryPath: fakeBwrap });
      } finally {
        NodeFS.rmSync(binDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "wraps Codex, ACP client terminals, and TerminalManager spawns when enabled and stays a no-op when disabled",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-integration-");
        try {
          const binDir = NodePath.join(root, "bin");
          const baseDir = NodePath.join(root, "runner");
          const wtDir = NodePath.join(baseDir, "worktrees", "wt-alice");
          const siblingDir = NodePath.join(baseDir, "worktrees", "wt-bob");
          NodeFS.mkdirSync(binDir, { recursive: true });
          NodeFS.mkdirSync(wtDir, { recursive: true });
          NodeFS.mkdirSync(siblingDir, { recursive: true });

          const fakeBwrap = NodePath.join(binDir, "bwrap");
          const fakeCodex = NodePath.join(binDir, "codex");
          const fakeShell = NodePath.join(binDir, "sh");
          const fakeSocket = NodePath.join(root, "token.sock");
          NodeFS.writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.writeFileSync(fakeShell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.writeFileSync(fakeSocket, "");

          const probeCalls: Array<string> = [];
          const mockRunner = ProcessRunner.ProcessRunner.of({
            run: ({ command }) => {
              probeCalls.push(command);
              return Effect.succeed(makeProcessOutput(""));
            },
          });

          // 1. Disabled by default: zero probe calls, pass-through wrap.
          const disabledSandbox = yield* makeBwrapProcessSandbox.pipe(
            Effect.provide(ServerConfig.layerTest(wtDir, baseDir)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, mockRunner),
          );
          expect(disabledSandbox.enabled).toBe(false);
          expect(probeCalls).toHaveLength(0);

          // 2. Enabled: probes once and wraps commands with bwrap.
          const enabledConfigLayer = Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const cfg = yield* ServerConfig.ServerConfig;
              return { ...cfg, teamBwrapSandbox: true };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(wtDir, baseDir)));

          const enabledSandbox = yield* makeBwrapProcessSandbox.pipe(
            Effect.provide(enabledConfigLayer),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, mockRunner),
          );
          expect(enabledSandbox.enabled).toBe(true);
          expect(probeCalls).toEqual([fakeBwrap]);

          const stateDir = NodePath.join(baseDir, "userdata");
          const codexProfile = NodePath.join(stateDir, "team-profiles", "codex", "team-1");
          NodeFS.mkdirSync(codexProfile, { recursive: true });

          // 3. Codex spawn integration: wraps codex with bwrap, binds CODEX_HOME & broker socket.
          const codexCmd = yield* makeCodexAppServerSpawnCommand({
            command: fakeCodex,
            args: [
              "-c",
              `model_providers.openai_token_sharing={auth={command="${fakeCodex}",args=["__managed-chatgpt-token","${fakeSocket}","inst"]}}`,
              "app-server",
            ],
            cwd: wtDir,
            env: { PATH: binDir, CODEX_HOME: codexProfile },
            threadId: "thread-1",
          }).pipe(
            Effect.provideService(ProcessSandbox, enabledSandbox),
            Effect.provideService(AgentScope, AgentScope.defaultValue()),
          );
          expect(codexCmd._tag).toBe("StandardCommand");
          if (codexCmd._tag === "StandardCommand") {
            expect(codexCmd.command).toBe(fakeBwrap);
            expect(codexCmd.args).toContain("--unshare-pid");
            expect(codexCmd.args).toContain(wtDir);
            expect(codexCmd.args).toContain(codexProfile);
            expect(codexCmd.args).toContain(fakeSocket);
            expect(codexCmd.args).not.toContain(stateDir);
            expect(codexCmd.args).not.toContain(siblingDir);
            expect(codexCmd.args.at(-1)).toBe("app-server");
          }

          // 4. ACP client terminals: wraps inside bwrap, rejects escaping cwd, ignores untrusted request.env binds.
          const spawnedCommands: Array<{
            readonly command: string;
            readonly args: ReadonlyArray<string>;
          }> = [];
          const fakeHandle = ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4242),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
          const acpTerminals = yield* makeAcpClientTerminals({
            defaultCwd: wtDir,
            environment: { PATH: binDir },
          }).pipe(
            Effect.provideService(ProcessSandbox, enabledSandbox),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((cmd) => {
                if (cmd._tag === "StandardCommand") {
                  spawnedCommands.push({
                    command: cmd.command,
                    args: cmd.args.map((arg) => (typeof arg === "string" ? arg : String(arg))),
                  });
                }
                return Effect.succeed(fakeHandle);
              }),
            ),
          );

          // Valid in-workspace ACP terminal command is wrapped in bwrap, and untrusted CODEX_HOME pointing at stateDir is ignored for binds.
          yield* acpTerminals.create({
            sessionId: "acp-sess-1",
            command: "/bin/echo",
            args: ["hello"],
            cwd: wtDir,
            env: [{ name: "CODEX_HOME", value: stateDir }],
          });
          expect(spawnedCommands).toHaveLength(1);
          expect(spawnedCommands[0]?.command).toBe(fakeBwrap);
          expect(spawnedCommands[0]?.args).toContain(wtDir);
          expect(spawnedCommands[0]?.args).not.toContain(stateDir);

          // Escaping cwd outside defaultCwd fails closed.
          const escapedAcp = yield* Effect.result(
            acpTerminals.create({
              sessionId: "acp-sess-1",
              command: "/bin/echo",
              args: ["nope"],
              cwd: siblingDir,
            }),
          );
          expect(Result.isFailure(escapedAcp)).toBe(true);
          yield* acpTerminals.disposeAll;

          // 5. TerminalManager PTY spawn: wraps shell in bwrap, and fails closed on missing active sandbox or forbidden cwd.
          const ptySpawns: Array<PtyAdapter.PtySpawnInput> = [];
          const fakePtyAdapter = PtyAdapter.PtyAdapter.of({
            spawn: (input) => {
              ptySpawns.push(input);
              const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
              let exited = false;
              const proc: PtyAdapter.PtyProcess = {
                pid: 9001,
                write: () => {},
                resize: () => {},
                kill: () => {
                  if (exited) return;
                  exited = true;
                  for (const listener of exitListeners) {
                    listener({ exitCode: 0, signal: null });
                  }
                },
                onData: () => () => {},
                onExit: (listener) => {
                  exitListeners.add(listener);
                  return () => {
                    exitListeners.delete(listener);
                  };
                },
              };
              return Effect.succeed(proc);
            },
          });

          const terminalManager = yield* TerminalManager.makeWithOptions({
            logsDir: NodePath.join(root, "term-logs"),
            teamBwrapSandbox: true,
            processSandbox: enabledSandbox,
            ptyAdapter: fakePtyAdapter,
            shellResolver: () => fakeShell,
            env: { PATH: binDir },
          }).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(AgentScope, AgentScope.defaultValue()),
            Effect.provideService(ProcessRunner.ProcessRunner, mockRunner),
          );

          yield* terminalManager.open({
            threadId: "thread-term-1",
            terminalId: "default",
            cwd: wtDir,
            cols: 80,
            rows: 24,
          });
          expect(ptySpawns).toHaveLength(1);
          expect(ptySpawns[0]?.shell).toBe(fakeBwrap);
          expect(ptySpawns[0]?.args).toContain("--unshare-pid");
          expect(ptySpawns[0]?.args).toContain(wtDir);
          expect(ptySpawns[0]?.args).toContain(fakeShell);
          yield* terminalManager.close({ threadId: "thread-term-1", terminalId: "default" });

          // TerminalManager fails closed if teamBwrapSandbox=true without an active sandbox.
          const misconfiguredTerminalManager = yield* TerminalManager.makeWithOptions({
            logsDir: NodePath.join(root, "term-logs-2"),
            teamBwrapSandbox: true,
            processSandbox: ProcessSandbox.defaultValue(),
            ptyAdapter: fakePtyAdapter,
            shellResolver: () => fakeShell,
            env: { PATH: binDir },
          }).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(AgentScope, AgentScope.defaultValue()),
            Effect.provideService(ProcessRunner.ProcessRunner, mockRunner),
          );
          const misconfiguredOpen = yield* Effect.result(
            misconfiguredTerminalManager.open({
              threadId: "thread-term-2",
              terminalId: "default",
              cwd: wtDir,
              cols: 80,
              rows: 24,
            }),
          );
          expect(Result.isFailure(misconfiguredOpen)).toBe(true);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  // End of NodeServices.layer suite; real-bwrap live integration test follows below.
});

it.live.skipIf(REAL_BWRAP_BINARY === null)(
  "enforces real Linux bwrap mount and PID namespace isolation when bwrap + userns are available",
  () =>
    Effect.gen(function* () {
      const bwrapBinary = REAL_BWRAP_BINARY!;
      const root = makeTempFixtureDir("t3-bwrap-real-");
      try {
        const ownStateDir = NodePath.join(root, "userdata");
        const wtAlice = NodePath.join(root, "worktrees", "wt-alice");
        const wtBob = NodePath.join(root, "worktrees", "wt-bob");
        NodeFS.mkdirSync(ownStateDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(ownStateDir, "statev2.sqlite"), "SECRET_DB");
        NodeFS.mkdirSync(wtAlice, { recursive: true });
        NodeFS.mkdirSync(wtBob, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(wtAlice, "alice.txt"), "hello-alice");
        NodeFS.writeFileSync(NodePath.join(wtBob, "bob-secret.txt"), "secret-bob");

        const script = [
          `cat "${wtAlice}/alice.txt"`,
          `echo ""`,
          `if [ -e "${wtBob}/bob-secret.txt" ]; then echo "LEAK_SIBLING"; else echo "NO_SIBLING"; fi`,
          `if [ -e "${ownStateDir}/statev2.sqlite" ]; then echo "LEAK_USERDATA"; else echo "NO_USERDATA"; fi`,
          `if [ -d "/proc/${process.pid}" ]; then echo "LEAK_HOST_PID"; else echo "ISOLATED_PID"; fi`,
        ].join("; ");

        const wrapped = yield* wrapCommandWithBwrap({
          bwrapBinaryPath: bwrapBinary,
          command: "/bin/sh",
          args: ["-c", script],
          cwd: wtAlice,
          ownStateDir,
        });

        const output = NodeChildProcess.spawnSync(wrapped.command, [...wrapped.args], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(output.status).toBe(0);
        expect(output.stdout).toContain("hello-alice");
        expect(output.stdout).toContain("NO_SIBLING");
        expect(output.stdout).toContain("NO_USERDATA");
        expect(output.stdout).toContain("ISOLATED_PID");
        expect(output.stdout).not.toContain("LEAK_");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);
