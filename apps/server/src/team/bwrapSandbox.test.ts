// @effect-diagnostics nodeBuiltinImport:off -- Uses mkdtemp/chmod/symlink/net/spawnSync to test canonical path resolution, Unix sockets, git worktrees, and optional real bwrap execution.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { makeAcpClientTerminals } from "@t3tools/provider-acp/server/clientTerminals";
import {
  AgentScope,
  ProcessSandbox,
  sanitizeHostEnvForSandboxLaunch,
} from "@t3tools/shared/AgentScope";
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
import { resolveClaudeSandboxExtraRoBinds } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  buildBwrapArgs,
  buildBwrapProbeArgs,
  checkBwrapAvailability,
  classifyBwrapProbeFailure,
  extractSandboxBindsFromEnv,
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

async function createTempUnixSocket(socketPath: string): Promise<() => Promise<void>> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
  it("builds namespace, OS ro-binds, writable scratch HOME, isolated /tmp before /tmp binds, and worktree locks", () => {
    const args = buildBwrapArgs({
      bwrapBinaryPath: "/usr/bin/bwrap",
      cwd: "/tmp/t3-workspaces/wt-alice",
      chdir: "/tmp/t3-workspaces/wt-alice",
      gitWorktree: {
        dotGitFile: "/tmp/t3-workspaces/wt-alice/.git",
        commonDir: "/srv/repos/app/.git",
        worktreeGitDir: "/srv/repos/app/.git/worktrees/wt-alice",
        maskWorktreesDir: "/srv/repos/app/.git/worktrees",
        hooksDir: "/srv/repos/app/.git/hooks",
        configFile: "/srv/repos/app/.git/config",
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
      sandboxEnv: { CUSTOM_FLAG: "1" },
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
    expect(args).toContain("/run/NetworkManager/resolv.conf");
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");

    // Writable scratch HOME and XDG dirs live under private /tmp/t3-home.
    expect(args).toContain("/tmp/t3-home");
    const homeEnvIdx = args.indexOf("HOME");
    expect(homeEnvIdx).toBeGreaterThan(-1);
    expect(args[homeEnvIdx - 1]).toBe("--setenv");
    expect(args[homeEnvIdx + 1]).toBe("/tmp/t3-home");

    const tmpfsIdx = args.indexOf("--tmpfs");
    const cwdBindIdx = args.indexOf("/tmp/t3-workspaces/wt-alice");
    const socketIdx = args.indexOf("/tmp/t3-token-123/s");
    const helperIdx = args.indexOf("/tmp/t3-turn-1/askpass.sh");
    expect(tmpfsIdx).toBeGreaterThan(-1);
    expect(args[tmpfsIdx + 1]).toBe("/tmp");
    expect(cwdBindIdx).toBeGreaterThan(tmpfsIdx);
    expect(socketIdx).toBeGreaterThan(tmpfsIdx);
    expect(helperIdx).toBeGreaterThan(tmpfsIdx);

    // Linked git worktree locks down .git pointer RO, isolates hooks via tmpfs, locks config RO,
    // and masks sibling .git/worktrees/* via tmpfs before re-binding wt-alice.
    const dotGitIdx = args.indexOf("/tmp/t3-workspaces/wt-alice/.git");
    expect(dotGitIdx).toBeGreaterThan(cwdBindIdx);
    expect(args[dotGitIdx - 1]).toBe("--ro-bind");

    const commonIdx = args.indexOf("/srv/repos/app/.git");
    const hooksIdx = args.indexOf("/srv/repos/app/.git/hooks");
    const configIdx = args.indexOf("/srv/repos/app/.git/config");
    const maskIdx = args.indexOf("/srv/repos/app/.git/worktrees");
    const wtGitIdx = args.indexOf("/srv/repos/app/.git/worktrees/wt-alice");
    const wtConfigIdx = args.indexOf("/srv/repos/app/.git/worktrees/wt-alice/config.worktree");
    expect(commonIdx).toBeGreaterThan(-1);
    expect(hooksIdx).toBeGreaterThan(commonIdx);
    expect(args[hooksIdx - 1]).toBe("--tmpfs");
    expect(configIdx).toBeGreaterThan(commonIdx);
    expect(args[configIdx - 1]).toBe("--ro-bind");
    expect(maskIdx).toBeGreaterThan(commonIdx);
    expect(args[maskIdx - 1]).toBe("--tmpfs");
    expect(wtGitIdx).toBeGreaterThan(maskIdx);
    expect(args[wtGitIdx - 1]).toBe("--bind");
    expect(wtConfigIdx).toBeGreaterThan(wtGitIdx);
    expect(args[wtConfigIdx - 2]).toBe("--ro-bind");
    expect(args[wtConfigIdx - 1]).toBe("/dev/null");

    // Deduplicated profile bind and already-covered OS binds (/usr, /opt) are not duplicated.
    const profileOccurrences = args.filter(
      (entry) => entry === "/var/lib/t3runner/userdata/team-profiles/codex/abc123",
    );
    expect(profileOccurrences).toHaveLength(2);
    expect(args).not.toContain("/usr/bin/node");
    expect(args).not.toContain("/opt/custom/bin/tool");
    expect(args).toContain("/var/lib/t3runner/tools/codex");

    // Untrusted sandboxEnv applied via --setenv inside sandbox.
    const customIdx = args.indexOf("CUSTOM_FLAG");
    expect(customIdx).toBeGreaterThan(-1);
    expect(args[customIdx - 1]).toBe("--setenv");
    expect(args[customIdx + 1]).toBe("1");

    const separatorIdx = args.indexOf("--");
    expect(args.slice(separatorIdx - 2)).toEqual([
      "--chdir",
      "/tmp/t3-workspaces/wt-alice",
      "--",
      "/var/lib/t3runner/tools/codex",
      "app-server",
    ]);
  });

  it("extracts isolated profiles, turn helpers, GH_CONFIG_DIR, and broker sockets strictly from env", () => {
    const extracted = extractSandboxBindsFromEnv({
      GEMINI_HOME: "/var/lib/t3runner/userdata/providers/antigravity/hash1",
      CODEX_HOME: "/var/lib/t3runner/userdata/team-profiles/codex/hash2",
      CLAUDE_CONFIG_DIR: "/var/lib/t3runner/userdata/team-profiles/claudeAgent/hash3",
      PI_CODING_AGENT_DIR: "/var/lib/t3runner/userdata/providers/pi/default",
      T3_TEAM_PROFILE_DIR: "/var/lib/t3runner/userdata/team-profiles/pi/hash4",
      GIT_ASKPASS: "/tmp/t3-turn-a/askpass.sh",
      GH_CONFIG_DIR: "/tmp/t3-turn-a/gh",
      T3_GITHUB_BROKER_SOCKET: "/tmp/t3-turn-a/gh.sock",
      T3_ACP_MCP_NODE: "/var/lib/t3runner/tools/node",
      T3_ACP_MCP_ENTRYPOINT: "/var/lib/t3runner/tools/bin.mjs",
    });

    expect(extracted.providerProfileDirs).toEqual([
      "/var/lib/t3runner/userdata/providers/antigravity/hash1",
      "/var/lib/t3runner/userdata/team-profiles/codex/hash2",
      "/var/lib/t3runner/userdata/team-profiles/claudeAgent/hash3",
      "/var/lib/t3runner/userdata/providers/pi/default",
      "/var/lib/t3runner/userdata/team-profiles/pi/hash4",
    ]);
    expect(extracted.helperRoPaths).toEqual([
      "/tmp/t3-turn-a/askpass.sh",
      "/var/lib/t3runner/tools/node",
      "/var/lib/t3runner/tools/bin.mjs",
    ]);
    expect(extracted.helperRwDirs).toEqual(["/tmp/t3-turn-a/gh"]);
    expect(extracted.socketPaths).toEqual(["/tmp/t3-turn-a/gh.sock"]);
  });

  it("strips loader and shell-startup variables from host sandbox launch environment", () => {
    const sanitized = sanitizeHostEnvForSandboxLaunch({
      PATH: "/usr/bin:/bin",
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp/evil-libs",
      LD_AUDIT: "/tmp/audit.so",
      BASH_ENV: "/tmp/evil.sh",
      "BASH_FUNC_evil%%": "() { id; }",
      ENV: "/tmp/evil.sh",
      GCONV_PATH: "/tmp/gconv",
      LOCPATH: "/tmp/locales",
      NODE_OPTIONS: "--require /tmp/evil.js",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      TERM: "xterm-256color",
    });

    expect(sanitized).toEqual({
      PATH: "/usr/bin:/bin",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      TERM: "xterm-256color",
    });
  });

  it("resolves Claude Agent SDK extra RO bind directories without throwing and never widens /tmp", () => {
    const binds = resolveClaudeSandboxExtraRoBinds(undefined);
    expect(binds.some((dir) => dir.includes("claude-agent-sdk"))).toBe(true);
    const tmpScriptBinds = resolveClaudeSandboxExtraRoBinds("/tmp/claude.js");
    expect(tmpScriptBinds).not.toContain("/tmp");
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
  it.effect(
    "resolves linked git worktree common-dir with bidirectional verification, RO .git/config, tmpfs hooks, and masked sibling worktrees",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-wt-");
        try {
          const ownStateDir = NodePath.join(root, "runner", "userdata");
          NodeFS.mkdirSync(ownStateDir, { recursive: true });

          const mainRepo = NodePath.join(root, "repos", "main");
          const mainGitDir = NodePath.join(mainRepo, ".git");
          const wtAliceGitDir = NodePath.join(mainGitDir, "worktrees", "wt-alice");
          const wtBobGitDir = NodePath.join(mainGitDir, "worktrees", "wt-bob");
          NodeFS.mkdirSync(NodePath.join(mainGitDir, "objects"), { recursive: true });
          NodeFS.mkdirSync(NodePath.join(mainGitDir, "hooks"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(mainGitDir, "HEAD"), "ref: refs/heads/main\n");
          NodeFS.writeFileSync(
            NodePath.join(mainGitDir, "config"),
            "[core]\n\trepositoryformatversion = 0\n",
          );
          NodeFS.mkdirSync(wtAliceGitDir, { recursive: true });
          NodeFS.mkdirSync(wtBobGitDir, { recursive: true });

          const wtAlice = NodePath.join(root, "worktrees", "wt-alice");
          const wtBob = NodePath.join(root, "worktrees", "wt-bob");
          NodeFS.mkdirSync(wtAlice, { recursive: true });
          NodeFS.mkdirSync(wtBob, { recursive: true });
          const wtAliceDotGit = NodePath.join(wtAlice, ".git");
          const wtBobDotGit = NodePath.join(wtBob, ".git");
          NodeFS.writeFileSync(wtAliceDotGit, `gitdir: ${wtAliceGitDir}\n`);
          NodeFS.writeFileSync(wtBobDotGit, `gitdir: ${wtBobGitDir}\n`);
          NodeFS.writeFileSync(NodePath.join(wtAliceGitDir, "commondir"), "../..\n");
          NodeFS.writeFileSync(NodePath.join(wtAliceGitDir, "gitdir"), `${wtAliceDotGit}\n`);
          NodeFS.writeFileSync(NodePath.join(wtBobGitDir, "commondir"), "../..\n");
          NodeFS.writeFileSync(NodePath.join(wtBobGitDir, "gitdir"), `${wtBobDotGit}\n`);

          const wrapped = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: ["-c", "git status"],
            cwd: wtAlice,
            ownStateDir,
          });

          expect(wrapped.command).toBe("/usr/bin/bwrap");
          expect(wrapped.args).toContain(wtAlice);
          expect(wrapped.args).toContain(wtAliceDotGit);
          expect(wrapped.args).toContain(mainGitDir);
          expect(wrapped.args).toContain(wtAliceGitDir);
          expect(wrapped.args).not.toContain(mainRepo);
          expect(wrapped.args).not.toContain(wtBob);
          expect(wrapped.args).not.toContain(wtBobGitDir);

          // Hooks masked via tmpfs, config & absent config.worktree locked RO, and sibling worktrees masked via tmpfs.
          const hooksIdx = wrapped.args.indexOf(NodePath.join(mainGitDir, "hooks"));
          expect(hooksIdx).toBeGreaterThan(-1);
          expect(wrapped.args[hooksIdx - 1]).toBe("--tmpfs");

          const configIdx = wrapped.args.indexOf(NodePath.join(mainGitDir, "config"));
          expect(configIdx).toBeGreaterThan(-1);
          expect(wrapped.args[configIdx - 1]).toBe("--ro-bind");

          const wtConfigPath = NodePath.join(wtAliceGitDir, "config.worktree");
          const absentWtConfigIdx = wrapped.args.indexOf(wtConfigPath);
          expect(absentWtConfigIdx).toBeGreaterThan(-1);
          expect(wrapped.args[absentWtConfigIdx - 2]).toBe("--ro-bind");
          const emptyStubPath = wrapped.args[absentWtConfigIdx - 1]!;
          expect(emptyStubPath).not.toBe("/dev/null");
          const emptyStubStat = NodeFS.statSync(emptyStubPath);
          expect(emptyStubStat.isFile()).toBe(true);
          expect(emptyStubStat.size).toBe(0);

          // When config.worktree already exists, bind the existing file read-only (not /dev/null).
          NodeFS.writeFileSync(wtConfigPath, "[core]\n\tsparseCheckout = true\n");
          const wrappedWithWtConfig = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: ["-c", "git status"],
            cwd: wtAlice,
            ownStateDir,
          });
          const presentWtConfigIdx = wrappedWithWtConfig.args.indexOf(wtConfigPath);
          expect(presentWtConfigIdx).toBeGreaterThan(-1);
          expect(wrappedWithWtConfig.args[presentWtConfigIdx - 1]).toBe("--ro-bind");
          expect(wrappedWithWtConfig.args[presentWtConfigIdx + 1]).toBe(wtConfigPath);

          const maskIdx = wrapped.args.indexOf(NodePath.join(mainGitDir, "worktrees"));
          expect(maskIdx).toBeGreaterThan(-1);
          expect(wrapped.args[maskIdx - 1]).toBe("--tmpfs");

          // Tampered .git pointing directly at commonDir or at wt-bob's gitdir fails closed!
          const tamperedDirect = NodePath.join(root, "worktrees", "wt-tampered-direct");
          NodeFS.mkdirSync(tamperedDirect, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(tamperedDirect, ".git"), `gitdir: ${mainGitDir}\n`);
          const directResult = yield* Effect.result(
            wrapCommandWithBwrap({
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: tamperedDirect,
              ownStateDir,
            }),
          );
          expect(Result.isFailure(directResult)).toBe(true);

          const tamperedForeign = NodePath.join(root, "worktrees", "wt-tampered-foreign");
          NodeFS.mkdirSync(tamperedForeign, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(tamperedForeign, ".git"), `gitdir: ${wtBobGitDir}\n`);
          const foreignResult = yield* Effect.result(
            wrapCommandWithBwrap({
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: tamperedForeign,
              ownStateDir,
            }),
          );
          expect(Result.isFailure(foreignResult)).toBe(true);
          if (Result.isFailure(foreignResult) && isBwrapSandboxPathError(foreignResult.failure)) {
            expect(foreignResult.failure.reason).toBe("invalid_git_worktree");
          }
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "locks .git/hooks, .git/config, and sibling .git/worktrees for ordinary .git directory repos",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-regular-git-");
        try {
          const repoDir = NodePath.join(root, "repo");
          const gitDir = NodePath.join(repoDir, ".git");
          NodeFS.mkdirSync(NodePath.join(gitDir, "objects"), { recursive: true });
          NodeFS.mkdirSync(NodePath.join(gitDir, "worktrees", "wt-other"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(gitDir, "HEAD"), "ref: refs/heads/main\n");

          // Absent .git/config and .git/config.worktree are locked with a 0-byte regular file,
          // and `.git` itself is bind-mounted so `mv .git .git.bak` fails with EBUSY.
          const withoutConfig = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: ["-c", "true"],
            cwd: repoDir,
          });
          const bindTargets = withoutConfig.args.filter(
            (_, idx) => withoutConfig.args[idx - 1] === "--bind",
          );
          expect(bindTargets).toEqual([repoDir, gitDir]);
          const hooksIdx = withoutConfig.args.indexOf(NodePath.join(gitDir, "hooks"));
          expect(hooksIdx).toBeGreaterThan(-1);
          expect(withoutConfig.args[hooksIdx - 1]).toBe("--tmpfs");
          const absentConfigIdx = withoutConfig.args.indexOf(NodePath.join(gitDir, "config"));
          expect(absentConfigIdx).toBeGreaterThan(-1);
          expect(withoutConfig.args[absentConfigIdx - 2]).toBe("--ro-bind");
          const stubPath = withoutConfig.args[absentConfigIdx - 1]!;
          expect(stubPath).not.toBe("/dev/null");
          expect(NodeFS.statSync(stubPath).isFile()).toBe(true);
          expect(NodeFS.statSync(stubPath).size).toBe(0);
          const absentWtConfigIdx = withoutConfig.args.indexOf(
            NodePath.join(gitDir, "config.worktree"),
          );
          expect(absentWtConfigIdx).toBeGreaterThan(-1);
          expect(withoutConfig.args[absentWtConfigIdx - 2]).toBe("--ro-bind");
          expect(withoutConfig.args[absentWtConfigIdx - 1]).toBe(stubPath);
          const worktreesIdx = withoutConfig.args.indexOf(NodePath.join(gitDir, "worktrees"));
          expect(worktreesIdx).toBeGreaterThan(-1);
          expect(withoutConfig.args[worktreesIdx - 1]).toBe("--tmpfs");

          // Present .git/config and .git/config.worktree are bound read-only directly.
          const configPath = NodePath.join(gitDir, "config");
          const wtConfigPath = NodePath.join(gitDir, "config.worktree");
          NodeFS.writeFileSync(configPath, "[core]\n\trepositoryformatversion = 0\n");
          NodeFS.writeFileSync(wtConfigPath, "[core]\n\tsparseCheckout = true\n");
          const withConfig = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: ["-c", "true"],
            cwd: repoDir,
          });
          const presentConfigIdx = withConfig.args.indexOf(configPath);
          expect(presentConfigIdx).toBeGreaterThan(-1);
          expect(withConfig.args[presentConfigIdx - 1]).toBe("--ro-bind");
          expect(withConfig.args[presentConfigIdx + 1]).toBe(configPath);
          const presentWtConfigIdx = withConfig.args.indexOf(wtConfigPath);
          expect(presentWtConfigIdx).toBeGreaterThan(-1);
          expect(withConfig.args[presentWtConfigIdx - 1]).toBe("--ro-bind");
          expect(withConfig.args[presentWtConfigIdx + 1]).toBe(wtConfigPath);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "auto-binds npm package node_modules tree and non-system shebang interpreter RO for external script CLIs without widening unsafe roots",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-ext-cli-");
        try {
          const fakeHome = NodePath.join(root, "home", "runner");
          const toolsRoot = NodePath.join(fakeHome, ".local", "npm-global");
          const nodeModulesDir = NodePath.join(toolsRoot, "lib", "node_modules");
          const pkgDir = NodePath.join(nodeModulesDir, "@acme", "pi-cli");
          const scriptPath = NodePath.join(pkgDir, "dist", "cli.js");
          const nodeBinDir = NodePath.join(fakeHome, ".nvm", "v22", "bin");
          const fakeNode = NodePath.join(nodeBinDir, "node");
          const cwd = NodePath.join(root, "worktrees", "wt-1");
          NodeFS.mkdirSync(NodePath.dirname(scriptPath), { recursive: true });
          NodeFS.mkdirSync(nodeBinDir, { recursive: true });
          NodeFS.mkdirSync(cwd, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(pkgDir, "package.json"), '{"name":"@acme/pi-cli"}\n');
          NodeFS.writeFileSync(scriptPath, "#!/usr/bin/env node\nconsole.log('ok');\n", {
            mode: 0o755,
          });
          NodeFS.writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

          const wrapped = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: scriptPath,
            args: ["--mode", "rpc"],
            cwd,
            env: { HOME: fakeHome, PATH: `${nodeBinDir}:/usr/bin:/bin` },
          });
          const roBinds = wrapped.args.filter((_, idx) => wrapped.args[idx - 1] === "--ro-bind");
          expect(roBinds).toContain(scriptPath);
          expect(roBinds).toContain(nodeModulesDir);
          expect(roBinds).toContain(fakeNode);
          expect(roBinds).not.toContain(fakeHome);

          // Must never widen to HOME even if a stray package.json sits directly inside HOME.
          NodeFS.writeFileSync(NodePath.join(fakeHome, "package.json"), "{}\n");
          const homeScript = NodePath.join(fakeHome, "tool.js");
          NodeFS.writeFileSync(homeScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          const wrappedHomeScript = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: homeScript,
            args: [],
            cwd,
            env: { HOME: fakeHome, PATH: "/usr/bin:/bin" },
          });
          const homeRoBinds = wrappedHomeScript.args.filter(
            (_, idx) => wrappedHomeScript.args[idx - 1] === "--ro-bind",
          );
          expect(homeRoBinds).toContain(homeScript);
          expect(homeRoBinds).not.toContain(fakeHome);

          // Parent-directory symlink (`.../current/bin/tool` where `current -> v22` and `tool` is
          // a regular file) must bind both the lexical path and its canonical target RO.
          const versionedDir = NodePath.join(fakeHome, ".local", "versions", "v22", "bin");
          const realTool = NodePath.join(versionedDir, "tool");
          const currentLink = NodePath.join(fakeHome, ".local", "versions", "current");
          NodeFS.mkdirSync(versionedDir, { recursive: true });
          NodeFS.writeFileSync(realTool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.symlinkSync(NodePath.join(fakeHome, ".local", "versions", "v22"), currentLink);
          const lexicalTool = NodePath.join(currentLink, "bin", "tool");
          const wrappedParentSymlink = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: lexicalTool,
            args: [],
            cwd,
            env: { HOME: fakeHome, PATH: "/usr/bin:/bin" },
          });
          const parentSymRoBinds = wrappedParentSymlink.args.filter(
            (_, idx) => wrappedParentSymlink.args[idx - 1] === "--ro-bind",
          );
          expect(parentSymRoBinds).toContain(lexicalTool);
          expect(parentSymRoBinds).toContain(realTool);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "rejects forbidden userdata, non-socket socketPaths, args injection, and allows managed Codex 4-segment shadow homes",
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
          const managedShadowHome = NodePath.join(
            ownStateDir,
            "providers",
            "codex",
            "team__team-1__codex",
            "shadow",
          );
          const piProfileDir = NodePath.join(ownStateDir, "providers", "pi", "pi-default");
          const hubBase = NodePath.join(root, "t3hub");
          const hubUserdata = NodePath.join(hubBase, "userdata");
          const validCwd = NodePath.join(runnerBase, "worktrees", "wt-alice");
          const siblingDir = NodePath.join(runnerBase, "worktrees", "wt-bob");

          NodeFS.mkdirSync(secretsDir, { recursive: true });
          NodeFS.writeFileSync(sqlitePath, "sqlite");
          NodeFS.mkdirSync(isolatedCodexProfile, { recursive: true });
          NodeFS.mkdirSync(managedShadowHome, { recursive: true });
          NodeFS.mkdirSync(piProfileDir, { recursive: true });
          NodeFS.mkdirSync(hubUserdata, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(hubUserdata, "statev2.sqlite"), "hub-db");
          NodeFS.mkdirSync(validCwd, { recursive: true });
          NodeFS.mkdirSync(siblingDir, { recursive: true });

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

          // Runner userdata root, ancestor baseDir, secrets, statev2.sqlite, /tmp, /dev, /proc, and $HOME are refused.
          const fakeHome = NodePath.join(root, "fake-home");
          NodeFS.mkdirSync(fakeHome, { recursive: true });
          for (const forbidden of [
            runnerBase,
            ownStateDir,
            secretsDir,
            sqlitePath,
            "/tmp",
            "/dev",
            "/proc",
            fakeHome,
          ]) {
            yield* expectPathFailure(
              {
                bwrapBinaryPath: "/usr/bin/bwrap",
                command: "/bin/sh",
                args: [],
                cwd: validCwd,
                ownStateDir,
                env: { HOME: fakeHome },
                extraRwBinds: [forbidden],
              },
              "forbidden_userdata_path",
            );
          }
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              ownStateDir,
              env: { HOME: fakeHome },
              extraRoBinds: ["/tmp"],
            },
            "forbidden_userdata_path",
          );

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

          // Managed Codex 4-segment shadow home + shared team profile + Pi profile ARE allowed as providerProfileDirs...
          const allowedManaged = yield* wrapCommandWithBwrap({
            bwrapBinaryPath: "/usr/bin/bwrap",
            command: "/bin/sh",
            args: ["-c", "true", "__managed-chatgpt-token", siblingDir],
            cwd: validCwd,
            ownStateDir,
            forbiddenUserdataDirs: [hubBase, hubUserdata],
            env: { CODEX_HOME: managedShadowHome, PI_CODING_AGENT_DIR: piProfileDir },
            providerProfileDirs: [isolatedCodexProfile],
          });
          expect(allowedManaged.args).toContain(managedShadowHome);
          expect(allowedManaged.args).toContain(piProfileDir);
          expect(allowedManaged.args).toContain(isolatedCodexProfile);
          expect(allowedManaged.args).not.toContain(ownStateDir);
          // Process args containing __managed-chatgpt-token MUST NEVER trigger a --bind of siblingDir!
          const bindTargets = allowedManaged.args.filter(
            (_, idx) => allowedManaged.args[idx - 1] === "--bind",
          );
          expect(bindTargets).not.toContain(siblingDir);

          // Regular files and directories passed as socketPaths are rejected with invalid_socket.
          const fakeFile = NodePath.join(root, "not-a-socket");
          NodeFS.writeFileSync(fakeFile, "nope");
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              ownStateDir,
              socketPaths: [fakeFile],
            },
            "invalid_socket",
          );
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              ownStateDir,
              socketPaths: [siblingDir],
            },
            "invalid_socket",
          );

          // Real Unix domain socket IS accepted for socketPaths.
          const realSock = NodePath.join(root, "broker.sock");
          const closeSocket = yield* Effect.promise(() => createTempUnixSocket(realSock));
          try {
            const withSocket = yield* wrapCommandWithBwrap({
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              ownStateDir,
              socketPaths: [realSock],
            });
            expect(withSocket.args).toContain(realSock);
          } finally {
            yield* Effect.promise(closeSocket);
          }

          // Untrusted sandboxEnv with NUL or '=' in key fails closed.
          yield* expectPathFailure(
            {
              bwrapBinaryPath: "/usr/bin/bwrap",
              command: "/bin/sh",
              args: [],
              cwd: validCwd,
              ownStateDir,
              sandboxEnv: { "BAD=KEY": "1" },
            },
            "invalid_env",
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
    "wraps Codex, ACP client terminals, and TerminalManager safely (blocks host LD_PRELOAD, args mount injection, and preserves PTY job control)",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-integration-");
        let closeSocket: (() => Promise<void>) | undefined;
        try {
          const binDir = NodePath.join(root, "bin");
          const baseDir = NodePath.join(root, "runner");
          const wtDir = NodePath.join(baseDir, "worktrees", "wt-alice");
          const wtSubDir = NodePath.join(wtDir, "apps", "web");
          const siblingDir = NodePath.join(baseDir, "worktrees", "wt-bob");
          NodeFS.mkdirSync(binDir, { recursive: true });
          NodeFS.mkdirSync(wtSubDir, { recursive: true });
          NodeFS.mkdirSync(siblingDir, { recursive: true });

          const fakeBwrap = NodePath.join(binDir, "bwrap");
          const fakeCodex = NodePath.join(binDir, "codex");
          const fakeShell = NodePath.join(binDir, "sh");
          const realSocket = NodePath.join(root, "token.sock");
          NodeFS.writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          NodeFS.writeFileSync(fakeShell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          closeSocket = yield* Effect.promise(() => createTempUnixSocket(realSocket));

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
          const codexShadow = NodePath.join(
            stateDir,
            "providers",
            "codex",
            "team__team-1__codex",
            "shadow",
          );
          NodeFS.mkdirSync(codexProfile, { recursive: true });
          NodeFS.mkdirSync(codexShadow, { recursive: true });

          // 3. Codex spawn integration: explicit extraSocketPaths + shadow/shared profile binds + extendEnv: false.
          const codexCmd = yield* makeCodexAppServerSpawnCommand({
            command: fakeCodex,
            args: ["app-server"],
            cwd: wtDir,
            env: { PATH: binDir, CODEX_HOME: codexShadow },
            extendEnv: true,
            extraProviderProfileDirs: [codexProfile],
            extraSocketPaths: [realSocket],
            threadId: "thread-1",
          }).pipe(
            Effect.provideService(HostProcess.Environment, {
              PATH: binDir,
              LD_PRELOAD: `${wtDir}/evil.so`,
              NODE_OPTIONS: "--require /tmp/evil.js",
            }),
            Effect.provideService(ProcessSandbox, enabledSandbox),
            Effect.provideService(AgentScope, AgentScope.defaultValue()),
          );
          expect(codexCmd._tag).toBe("StandardCommand");
          if (codexCmd._tag === "StandardCommand") {
            expect(codexCmd.command).toBe(fakeBwrap);
            expect(codexCmd.args).toContain("--unshare-pid");
            expect(codexCmd.args).toContain("--new-session");
            expect(codexCmd.args).toContain(wtDir);
            expect(codexCmd.args).toContain(codexShadow);
            expect(codexCmd.args).toContain(codexProfile);
            expect(codexCmd.args).toContain(realSocket);
            expect(codexCmd.args).not.toContain(stateDir);
            expect(codexCmd.args).not.toContain(siblingDir);
            expect(codexCmd.args.at(-1)).toBe("app-server");
            expect(codexCmd.options.extendEnv).toBe(false);
            expect(codexCmd.options.env?.LD_PRELOAD).toBeUndefined();
            expect(codexCmd.options.env?.NODE_OPTIONS).toBeUndefined();
          }

          // 4. ACP client terminals: LD_PRELOAD must NOT enter host env (only --setenv inside bwrap),
          //    and __managed-chatgpt-token args must NOT authorize mounting siblingDir.
          const spawnedCommands: Array<{
            readonly command: string;
            readonly args: ReadonlyArray<string>;
            readonly env: Readonly<Record<string, unknown>> | undefined;
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
                    env: cmd.options.env,
                  });
                }
                return Effect.succeed(fakeHandle);
              }),
            ),
          );

          yield* acpTerminals.create({
            sessionId: "acp-sess-1",
            command: "/bin/sh",
            args: ["-c", "echo hi", "__managed-chatgpt-token", siblingDir],
            cwd: wtDir,
            env: [
              { name: "LD_PRELOAD", value: `${wtDir}/evil.so` },
              { name: "CODEX_HOME", value: stateDir },
            ],
          });
          expect(spawnedCommands).toHaveLength(1);
          const acpSpawn = spawnedCommands[0]!;
          expect(acpSpawn.command).toBe(fakeBwrap);
          // Host bwrap process MUST NOT receive untrusted LD_PRELOAD or CODEX_HOME!
          expect(acpSpawn.env?.LD_PRELOAD).toBeUndefined();
          expect(acpSpawn.env?.CODEX_HOME).toBeUndefined();
          // Untrusted env vars are forwarded strictly via --setenv inside bwrap.
          const ldIdx = acpSpawn.args.indexOf("LD_PRELOAD");
          expect(ldIdx).toBeGreaterThan(-1);
          expect(acpSpawn.args[ldIdx - 1]).toBe("--setenv");
          // Neither stateDir nor siblingDir is bind-mounted!
          const acpBinds = acpSpawn.args.filter(
            (_, idx) =>
              acpSpawn.args[idx - 1] === "--bind" || acpSpawn.args[idx - 1] === "--ro-bind",
          );
          expect(acpBinds).not.toContain(stateDir);
          expect(acpBinds).not.toContain(siblingDir);

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

          // 5. TerminalManager PTY spawn: omits --new-session for job control, mounts worktree root
          //    with chdir to subdir, keeps untrusted client env (LD_PRELOAD, GH_CONFIG_DIR) out of host env & mounts.
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
            cwd: wtSubDir,
            worktreePath: wtDir,
            env: {
              LD_PRELOAD: `${wtDir}/evil.so`,
              GH_CONFIG_DIR: siblingDir,
            },
            cols: 80,
            rows: 24,
          });
          expect(ptySpawns).toHaveLength(1);
          const ptySpawn = ptySpawns[0]!;
          expect(ptySpawn.shell).toBe(fakeBwrap);
          expect(ptySpawn.args).toContain("--unshare-pid");
          // PTY terminals omit --new-session so Ctrl+C / job control work.
          expect(ptySpawn.args).not.toContain("--new-session");
          // Mounts worktree root RW and chdirs into the requested subdirectory.
          const ptyBinds = (ptySpawn.args ?? []).filter((_, idx, arr) => arr[idx - 1] === "--bind");
          expect(ptyBinds).toContain(wtDir);
          expect(ptyBinds).not.toContain(siblingDir);
          const chdirIdx = (ptySpawn.args ?? []).indexOf("--chdir");
          expect(ptySpawn.args?.[chdirIdx + 1]).toBe(wtSubDir);
          // Host PTY env MUST NOT contain untrusted LD_PRELOAD or GH_CONFIG_DIR!
          expect(ptySpawn.env.LD_PRELOAD).toBeUndefined();
          expect(ptySpawn.env.GH_CONFIG_DIR).toBeUndefined();
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
          if (closeSocket !== undefined) {
            yield* Effect.promise(closeSocket);
          }
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "neutralizes core.fsmonitor, core.hooksPath, and clean/included filters on both GitVcsDriver and VcsProcess when teamBwrapSandbox is enabled",
    () =>
      Effect.gen(function* () {
        const root = makeTempFixtureDir("t3-bwrap-host-git-");
        try {
          const baseDir = NodePath.join(root, "runner");
          const mainRepo = NodePath.join(root, "repo");
          const wtAlice = NodePath.join(root, "worktrees", "wt-alice");
          const markerFile = NodePath.join(root, "host-git-pwned");
          const evilScript = NodePath.join(root, "evil-git-helper.sh");
          const includedCfg = NodePath.join(root, "included-filter.cfg");
          NodeFS.mkdirSync(mainRepo, { recursive: true });
          NodeFS.writeFileSync(evilScript, `#!/bin/sh\ntouch "${markerFile}"\ncat\n`, {
            mode: 0o755,
          });
          NodeFS.writeFileSync(includedCfg, `[filter "incfilter"]\n\tclean = ${evilScript}\n`);

          NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: mainRepo });
          NodeChildProcess.execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });
          NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.com"], {
            cwd: mainRepo,
          });
          NodeFS.writeFileSync(
            NodePath.join(mainRepo, ".gitattributes"),
            "*.txt filter=evil\n*.inc filter=incfilter\n",
          );
          NodeFS.writeFileSync(NodePath.join(mainRepo, "a.txt"), "hello\n");
          NodeFS.writeFileSync(NodePath.join(mainRepo, "b.inc"), "alpha\n");
          NodeChildProcess.execFileSync("git", ["add", ".gitattributes", "a.txt", "b.inc"], {
            cwd: mainRepo,
          });
          NodeChildProcess.execFileSync("git", ["commit", "-m", "init"], { cwd: mainRepo });
          NodeChildProcess.execFileSync("git", ["config", "extensions.worktreeConfig", "true"], {
            cwd: mainRepo,
          });
          NodeChildProcess.execFileSync("git", ["worktree", "add", "-b", "alice", wtAlice], {
            cwd: mainRepo,
          });
          // Plant hostile fsmonitor + direct/included clean filters + 300KB comment-padded single-line
          // [core] sshCommand + URL-scoped credential helper + remote.origin.uploadpack.
          const includedCommentCfg = NodePath.join(root, "included-single-line.cfg");
          NodeFS.writeFileSync(
            includedCommentCfg,
            `[filter "singleline"] clean = ${evilScript}\n[credential "https://example.test"] helper = !${evilScript}\n`,
          );
          NodeFS.appendFileSync(
            NodePath.join(mainRepo, ".git", "config"),
            `\n# ${"x".repeat(300_000)}\n[core] sshCommand = ${evilScript}\n[core] gitProxy = ${evilScript} for example.invalid\n[include] path = ${includedCommentCfg} # inline comment\n[remote "origin"]\n\tuploadpack = ${evilScript}\n`,
          );
          NodeChildProcess.execFileSync("git", ["config", "core.fsmonitor", evilScript], {
            cwd: mainRepo,
          });
          NodeChildProcess.execFileSync("git", ["config", "filter.evil.clean", evilScript], {
            cwd: mainRepo,
          });
          NodeChildProcess.execFileSync("git", ["config", "--add", "include.path", includedCfg], {
            cwd: mainRepo,
          });
          NodeChildProcess.execFileSync(
            "git",
            ["config", "--worktree", "core.fsmonitor", evilScript],
            { cwd: wtAlice },
          );
          // Verify async resolveSandboxSafeGitConfigEnv neutralizes padded, single-line, URL-scoped,
          // remote, conditional-include (triggered by global remote URL), and key-flooded configs,
          // AND fails closed on probe truncation/errors or workspace-local includes for unsandboxed Git.
          const runLocalGitProbe = (probe: {
            readonly args: ReadonlyArray<string>;
            readonly cwd: string | undefined;
            readonly env: NodeJS.ProcessEnv;
          }) =>
            Effect.sync(() => {
              const res = NodeChildProcess.spawnSync("git", [...probe.args], {
                ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
                env: probe.env,
                encoding: "utf8",
              });
              return {
                exitCode: res.status,
                stdout: res.stdout ?? "",
                timedOut: false,
                stdoutTruncated: false,
              };
            });
          const extractPairs = (envObj: NodeJS.ProcessEnv) => {
            const pairs = new Map<string, string>();
            const count = Number.parseInt(envObj.GIT_CONFIG_COUNT ?? "0", 10);
            for (let i = 0; i < count; i += 1) {
              const k = envObj[`GIT_CONFIG_KEY_${i}`];
              const v = envObj[`GIT_CONFIG_VALUE_${i}`];
              if (k !== undefined && v !== undefined) pairs.set(k.toLowerCase(), v);
            }
            return pairs;
          };

          // Conditional include triggered by global remote.origin.url + 4.5 MiB dummy key flood.
          const globalCfg = NodePath.join(root, "global.cfg");
          const condIncCfg = NodePath.join(root, "cond-include.cfg");
          NodeFS.writeFileSync(
            globalCfg,
            `[remote "origin"]\n\turl = https://corp.example.test/team/app.git\n[credential]\n\thelper = store\n`,
          );
          NodeFS.writeFileSync(condIncCfg, `[filter "condfilt"]\n\tclean = ${evilScript}\n`);
          const dummyPad = `[x "${"a".repeat(180)}"]\n\tk = 1\n`;
          NodeFS.appendFileSync(
            NodePath.join(mainRepo, ".git", "config"),
            `\n[includeIf "hasconfig:remote.*.url:https://corp.example.test/**"]\n\tpath = ${condIncCfg}\n` +
              dummyPad.repeat(24_000) +
              `[filter "afterflood"]\n\tclean = ${evilScript}\n`,
          );

          const hostPath = (yield* HostProcess.Environment).PATH;
          const computedGitEnv = yield* VcsProcess.resolveSandboxSafeGitConfigEnv({
            cwd: mainRepo,
            env: {
              PATH: hostPath,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: globalCfg,
            },
            platform: "linux",
            allowWorkspaceIncludes: true,
            runProbe: runLocalGitProbe,
          });
          const computedPairs = extractPairs(computedGitEnv);
          expect(computedPairs.get("filter.singleline.clean")).toBe("");
          expect(computedPairs.get("filter.condfilt.clean")).toBe("");
          expect(computedPairs.get("filter.afterflood.clean")).toBe("");
          expect(computedPairs.get("credential.https://example.test.helper")).toBe("");
          // Global host credential.helper MUST NOT be clobbered when only global scope sets it.
          expect(computedPairs.has("credential.helper")).toBe(false);
          expect(computedPairs.get("core.sshcommand")).toBe("false");
          expect(computedGitEnv.GIT_PROXY_COMMAND).toBe("false");
          expect(computedPairs.get("remote.origin.uploadpack")).toBe("git-upload-pack");
          expect(computedPairs.get("gpg.program")).toBe("false");

          // Value-taking global flags (`-c fetch.unpackLimit=1 --git-dir <bareDir>`) preserve `--git-dir`.
          const bareRepo = NodePath.join(root, "bare.git");
          NodeChildProcess.execFileSync("git", ["init", "--bare", bareRepo]);
          NodeChildProcess.execFileSync("git", [
            "--git-dir",
            bareRepo,
            "config",
            "remote.origin.uploadpack",
            evilScript,
          ]);
          const bareEnv = yield* VcsProcess.resolveSandboxSafeGitConfigEnv({
            cwd: root,
            env: { PATH: hostPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
            platform: "linux",
            args: ["-c", "fetch.unpackLimit=1", "--git-dir", bareRepo, "fetch", "--quiet"],
            allowWorkspaceIncludes: false,
            runProbe: runLocalGitProbe,
          });
          expect(extractPairs(bareEnv).get("remote.origin.uploadpack")).toBe("git-upload-pack");

          // Fail-closed when probe overflows/truncates or exits unexpectedly.
          const truncatedProbeResult = yield* Effect.result(
            VcsProcess.resolveSandboxSafeGitConfigEnv({
              cwd: mainRepo,
              env: { PATH: hostPath },
              platform: "linux",
              allowWorkspaceIncludes: false,
              runProbe: () =>
                Effect.succeed({
                  exitCode: 0,
                  stdout: "",
                  timedOut: false,
                  stdoutTruncated: true,
                }),
            }),
          );
          expect(Result.isFailure(truncatedProbeResult)).toBe(true);

          // Fail-closed for unsandboxed host Git on any repo-local include, including an
          // outward-pointing workspace symlink (`symlink.cfg -> /dev/null`) to prevent TOCTOU swaps.
          const wsIncludeRepo = NodePath.join(root, "ws-include-repo");
          const wsSubDir = NodePath.join(wsIncludeRepo, "packages", "app");
          NodeFS.mkdirSync(wsSubDir, { recursive: true });
          NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: wsIncludeRepo });
          NodeFS.writeFileSync(NodePath.join(wsIncludeRepo, "mutable.cfg"), "[core]\n");
          NodeChildProcess.execFileSync("git", ["config", "include.path", "../mutable.cfg"], {
            cwd: wsIncludeRepo,
          });
          const wsIncludeRefused = yield* Effect.result(
            VcsProcess.resolveSandboxSafeGitConfigEnv({
              cwd: wsIncludeRepo,
              env: { PATH: hostPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
              platform: "linux",
              allowWorkspaceIncludes: false,
              runProbe: runLocalGitProbe,
            }),
          );
          expect(Result.isFailure(wsIncludeRefused)).toBe(true);

          const symlinkIncludeRepo = NodePath.join(root, "ws-symlink-include-repo");
          NodeFS.mkdirSync(symlinkIncludeRepo, { recursive: true });
          NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: symlinkIncludeRepo });
          NodeFS.symlinkSync("/dev/null", NodePath.join(symlinkIncludeRepo, "symlink.cfg"));
          NodeChildProcess.execFileSync("git", ["config", "include.path", "../symlink.cfg"], {
            cwd: symlinkIncludeRepo,
          });
          const symlinkIncludeRefused = yield* Effect.result(
            VcsProcess.resolveSandboxSafeGitConfigEnv({
              cwd: symlinkIncludeRepo,
              env: { PATH: hostPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
              platform: "linux",
              allowWorkspaceIncludes: false,
              runProbe: runLocalGitProbe,
            }),
          );
          expect(Result.isFailure(symlinkIncludeRefused)).toBe(true);

          // Config-writing / global-identity subcommands, explicit `-C`/`--git-dir`, and relative
          // temp env paths must stay outside workspace sandbox wrapping.
          for (const ineligibleArgs of [
            ["config", "user.name", "Alice"],
            ["commit", "-m", "msg"],
            ["branch", "feat"],
            ["checkout", "main"],
            ["stash", "push"],
            ["tag", "v1"],
            ["-C", mainRepo, "status"],
            ["--git-dir", NodePath.join(mainRepo, ".git"), "status"],
          ]) {
            expect(
              VcsProcess.canRunHostGitInWorkspaceSandbox({
                processSandboxEnabled: true,
                cwd: wsIncludeRepo,
                args: ineligibleArgs,
                env: {},
                ownStateDir: baseDir,
              }).eligible,
            ).toBe(false);
          }
          expect(
            VcsProcess.canRunHostGitInWorkspaceSandbox({
              processSandboxEnabled: true,
              cwd: wsIncludeRepo,
              args: ["status"],
              env: { GIT_INDEX_FILE: "relative/index" },
              ownStateDir: baseDir,
            }).eligible,
          ).toBe(false);

          // Real bwrap ProcessSandbox + VcsProcess running from a repository subdirectory mounts
          // the enclosing repo root with `.git` locks, passes `--chdir <subDir>`, and disables
          // ProcessRunner `extendEnv` so host `LD_PRELOAD` is never re-merged onto bwrap.
          const subdirBinDir = NodePath.join(root, "subdir-bin");
          const subdirFakeBwrap = NodePath.join(subdirBinDir, "bwrap");
          NodeFS.mkdirSync(subdirBinDir, { recursive: true });
          NodeFS.writeFileSync(subdirFakeBwrap, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          const realSubdirSpawns: Array<ProcessRunner.ProcessRunInput> = [];
          const mockSubdirRunner = ProcessRunner.ProcessRunner.of({
            run: (runInput) => {
              if (runInput.command === subdirFakeBwrap && runInput.args.includes("true")) {
                return Effect.succeed(makeProcessOutput(""));
              }
              if (runInput.command === "git" && runInput.args.includes("--get-regexp")) {
                return Effect.succeed(makeProcessOutput("", "", 1));
              }
              realSubdirSpawns.push(runInput);
              return Effect.succeed(makeProcessOutput(""));
            },
          });
          const subdirServerConfigLayer = Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const cfg = yield* ServerConfig.ServerConfig;
              return { ...cfg, teamBwrapSandbox: true };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(wsIncludeRepo, baseDir)));
          const realBwrapSandbox = yield* makeBwrapProcessSandbox.pipe(
            Effect.provide(subdirServerConfigLayer),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: subdirBinDir }),
            Effect.provideService(ProcessRunner.ProcessRunner, mockSubdirRunner),
          );
          yield* Effect.gen(function* () {
            const vcsProc = yield* VcsProcess.VcsProcess;
            yield* vcsProc.run({
              operation: "GitVcsDriver.listWorkspaceFiles",
              command: "git",
              args: ["status", "--porcelain=2", "--branch", "-z"],
              cwd: wsSubDir,
              env: { LD_PRELOAD: "/tmp/should-not-leak-to-bwrap.so" },
            });
          }).pipe(
            Effect.provide(
              Layer.effect(VcsProcess.VcsProcess, VcsProcess.make).pipe(
                Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, mockSubdirRunner)),
                Layer.provide(subdirServerConfigLayer),
                Layer.provide(Layer.succeed(ProcessSandbox, realBwrapSandbox)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          expect(realSubdirSpawns).toHaveLength(1);
          const subdirSpawn = realSubdirSpawns[0]!;
          expect(subdirSpawn.command).toBe(subdirFakeBwrap);
          expect(subdirSpawn.extendEnv).toBe(false);
          expect(subdirSpawn.env?.LD_PRELOAD).toBeUndefined();
          const subdirBinds = subdirSpawn.args.filter(
            (_, idx) => subdirSpawn.args[idx - 1] === "--bind",
          );
          expect(subdirBinds).toContain(wsIncludeRepo);
          expect(subdirBinds).toContain(NodePath.join(wsIncludeRepo, ".git"));
          const subdirChdirIdx = subdirSpawn.args.indexOf("--chdir");
          expect(subdirSpawn.args[subdirChdirIdx + 1]).toBe(wsSubDir);

          // When ProcessSandbox is enabled, workspace-local host git commands run inside ProcessSandbox.
          const wrappedGitCalls: Array<ReadonlyArray<string>> = [];
          const trackingSandbox = {
            enabled: true,
            wrap: (wrapInput: {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
              readonly env?: NodeJS.ProcessEnv | undefined;
            }) => {
              wrappedGitCalls.push(wrapInput.args);
              return Effect.succeed({
                command: wrapInput.command,
                args: wrapInput.args,
                hostEnv: wrapInput.env,
              });
            },
          };
          yield* Effect.gen(function* () {
            const vcsProc = yield* VcsProcess.VcsProcess;
            yield* vcsProc.run({
              operation: "GitVcsDriver.listWorkspaceFiles",
              command: "git",
              args: ["status", "--porcelain=2", "--branch", "-z"],
              cwd: wsIncludeRepo,
            });
          }).pipe(
            Effect.provide(
              VcsProcess.layer.pipe(
                Layer.provide(
                  Layer.effect(
                    ServerConfig.ServerConfig,
                    Effect.gen(function* () {
                      const cfg = yield* ServerConfig.ServerConfig;
                      return { ...cfg, teamBwrapSandbox: true };
                    }),
                  ).pipe(Layer.provide(ServerConfig.layerTest(wsIncludeRepo, baseDir))),
                ),
                Layer.provide(Layer.succeed(ProcessSandbox, trackingSandbox)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          expect(wrappedGitCalls).toHaveLength(1);
          expect(wrappedGitCalls[0]?.[0]).toBe("status");
          // Modify tracked files with identical length and bumped mtime to force clean-filter evaluation.
          const futureEpochSec = 4_070_908_800;
          for (const dir of [mainRepo, wtAlice]) {
            const aFile = NodePath.join(dir, "a.txt");
            const bFile = NodePath.join(dir, "b.inc");
            NodeFS.writeFileSync(aFile, "world\n");
            NodeFS.writeFileSync(bFile, "gamma\n");
            NodeFS.utimesSync(aFile, futureEpochSec, futureEpochSec);
            NodeFS.utimesSync(bFile, futureEpochSec, futureEpochSec);
          }

          const sandboxServerConfigLayer = Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const cfg = yield* ServerConfig.ServerConfig;
              return { ...cfg, teamBwrapSandbox: true };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(mainRepo, baseDir)));

          const driverLayer = GitVcsDriver.layer.pipe(
            Layer.provide(sandboxServerConfigLayer),
            Layer.provide(Layer.succeed(ProcessSandbox, trackingSandbox)),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          const vcsProcessLayer = VcsProcess.layer.pipe(
            Layer.provide(sandboxServerConfigLayer),
            Layer.provide(Layer.succeed(ProcessSandbox, trackingSandbox)),
            Layer.provide(NodeServices.layer),
          );

          const statusOnMain = yield* Effect.gen(function* () {
            const vcs = yield* GitVcsDriver.GitVcsDriver;
            return yield* vcs.status({ cwd: mainRepo });
          }).pipe(Effect.provide(driverLayer));
          const statusOnWt = yield* Effect.gen(function* () {
            const vcs = yield* GitVcsDriver.GitVcsDriver;
            return yield* vcs.status({ cwd: wtAlice });
          }).pipe(Effect.provide(driverLayer));

          // Also exercise VcsProcess (used by checkpoints, WorkspaceEntries, WorkspaceSearchIndex).
          yield* Effect.gen(function* () {
            const vcsProc = yield* VcsProcess.VcsProcess;
            yield* vcsProc.run({
              operation: "GitVcsDriver.listWorkspaceFiles",
              command: "git",
              args: ["ls-files", "-v", "-z"],
              cwd: wtAlice,
            });
            yield* vcsProc.run({
              operation: "GitVcsDriver.checkpoints.captureCheckpoint",
              command: "git",
              args: ["status", "--porcelain=2", "--branch", "-z"],
              cwd: wtAlice,
            });
          }).pipe(Effect.provide(vcsProcessLayer));

          expect(statusOnMain.refName).toBe("main");
          expect(statusOnWt.refName).toBe("alice");
          expect(NodeFS.existsSync(markerFile)).toBe(false);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );
});

it.live.skipIf(REAL_BWRAP_BINARY === null)(
  "enforces real Linux bwrap mount, PID namespace, writable scratch HOME, and linked git worktree commit isolation when bwrap + userns are available",
  () =>
    Effect.gen(function* () {
      const bwrapBinary = REAL_BWRAP_BINARY!;
      const root = makeTempFixtureDir("t3-bwrap-real-");
      try {
        const ownStateDir = NodePath.join(root, "userdata");
        const mainRepo = NodePath.join(root, "repo");
        const wtAlice = NodePath.join(root, "worktrees", "wt-alice");
        const wtBob = NodePath.join(root, "worktrees", "wt-bob");
        NodeFS.mkdirSync(ownStateDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(ownStateDir, "statev2.sqlite"), "SECRET_DB");
        NodeFS.mkdirSync(mainRepo, { recursive: true });
        NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: mainRepo });
        NodeChildProcess.execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });
        NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.com"], {
          cwd: mainRepo,
        });
        NodeFS.writeFileSync(NodePath.join(mainRepo, "README.md"), "init\n");
        NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: mainRepo });
        NodeChildProcess.execFileSync("git", ["commit", "-m", "init"], { cwd: mainRepo });
        NodeChildProcess.execFileSync("git", ["worktree", "add", "-b", "alice", wtAlice], {
          cwd: mainRepo,
        });
        NodeChildProcess.execFileSync("git", ["worktree", "add", "-b", "bob", wtBob], {
          cwd: mainRepo,
        });
        NodeFS.writeFileSync(NodePath.join(wtAlice, "alice.txt"), "hello-alice");
        NodeFS.writeFileSync(NodePath.join(wtBob, "bob-secret.txt"), "secret-bob");

        const script = [
          `cat "${wtAlice}/alice.txt"`,
          `echo ""`,
          `if [ -e "${wtBob}/bob-secret.txt" ]; then echo "LEAK_SIBLING"; else echo "NO_SIBLING"; fi`,
          `if [ -e "${ownStateDir}/statev2.sqlite" ]; then echo "LEAK_USERDATA"; else echo "NO_USERDATA"; fi`,
          `if [ -d "/proc/${process.pid}" ]; then echo "LEAK_HOST_PID"; else echo "ISOLATED_PID"; fi`,
          `touch "$HOME/scratch-ok" && echo "HOME_WRITABLE"`,
          `if echo "tamper" > "${wtAlice}/.git" 2>/dev/null; then echo "LEAK_DOTGIT_RW"; else echo "DOTGIT_RO"; fi`,
          `if echo "tamper" >> "${mainRepo}/.git/config" 2>/dev/null; then echo "LEAK_CONFIG_RW"; else echo "CONFIG_RO"; fi`,
          `if echo "[core]" > "${mainRepo}/.git/worktrees/wt-alice/config.worktree" 2>/dev/null; then echo "LEAK_WTCONFIG_RW"; else echo "WTCONFIG_RO"; fi`,
          `git -c user.name=Alice -c user.email=alice@example.com add alice.txt && git -c user.name=Alice -c user.email=alice@example.com commit -m "alice commit" >/dev/null && echo "GIT_COMMIT_OK"`,
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
        expect(output.stdout).toContain("HOME_WRITABLE");
        expect(output.stdout).toContain("DOTGIT_RO");
        expect(output.stdout).toContain("CONFIG_RO");
        expect(output.stdout).toContain("WTCONFIG_RO");
        expect(output.stdout).toContain("GIT_COMMIT_OK");
        expect(output.stdout).not.toContain("LEAK_");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);
