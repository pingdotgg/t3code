// @effect-diagnostics nodeBuiltinImport:off - FIFO gates must be released with a synchronous
// open on the main thread, because the Effect FileSystem queues behind the pinned libuv pool.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentSessionImportSource,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { layerScannerTest, runScan, runRecentThreadOutcomes, runRecentThreads, makeTempDir, writeTranscript, claudeSessionLine, codexRolloutLine, decodeImportSource, encodeTranscriptRecord, makeRecordLimitTranscript, makeFileIdentityFixture, LIBUV_POOL_SIZE, makeOpenGate } from "./AgentSessionScanner-part2.testkit.ts";

const awaitGateReader = (gatePath: string) =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFS.promises.open(gatePath, NodeFS.constants.O_WRONLY)),
    (handle) => Effect.promise(() => handle.close()),
  );


it.layer(NodeServices.layer)("AgentSessionScanner", (it) => {
  describe("scan", () => {
    it.effect("drops candidates whose directory no longer exists", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(path.join(claudeHomePath, "does-not-exist")),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([]);
      }),
    );

    it.effect("excludes the home directory, temporary root, and T3 data directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        for (const [index, cwd] of [
          NodeOS.homedir(),
          NodeOS.tmpdir(),
          configBaseDir,
          workspace,
        ].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, "session.jsonl"),
            contents: claudeSessionLine(cwd),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z") + index,
          });
        }

        const result = yield* runScan({ claudeHomePath, codexHomePath, configBaseDir });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
      }),
    );

    it.effect("excludes T3-managed worktree sandboxes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const fileSystem = yield* FileSystem.FileSystem;

        const worktreeCwd = path.join(claudeHomePath, ".t3", "worktrees", "t3code", "wt-1");
        yield* fileSystem.makeDirectory(worktreeCwd, { recursive: true });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(worktreeCwd),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([]);
      }),
    );

    it.effect("skips linked git worktrees and reports the origin of real checkouts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const repo = yield* makeTempDir("t3code-workspace-repo-");
        const worktree = yield* makeTempDir("t3code-workspace-worktree-");
        const plain = yield* makeTempDir("t3code-workspace-plain-");
        const noRemote = yield* makeTempDir("t3code-workspace-noremote-");
        const submodule = yield* makeTempDir("t3code-workspace-submodule-");

        yield* fileSystem.makeDirectory(path.join(repo, ".git"));
        yield* fileSystem.writeFileString(
          path.join(repo, ".git", "config"),
          '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:pingdotgg/t3code.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
        );
        const worktreeGitDir = path.join(repo, ".git", "worktrees", "wt");
        yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${worktreeGitDir}\n`,
        );
        yield* fileSystem.makeDirectory(path.join(noRemote, ".git"));
        yield* fileSystem.writeFileString(path.join(noRemote, ".git", "config"), "[core]\n");
        const submoduleGitDir = path.join(repo, ".git", "modules", "vendor");
        yield* fileSystem.makeDirectory(submoduleGitDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(submoduleGitDir, "config"),
          '[remote "origin"]\n\turl = ssh://gitlab.com/pingdotgg/libs/vendor.git\n',
        );
        yield* fileSystem.writeFileString(
          path.join(submodule, ".git"),
          `gitdir: ${submoduleGitDir}\n`,
        );

        for (const [index, cwd] of [repo, worktree, plain, noRemote, submodule].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, "a.jsonl"),
            contents: claudeSessionLine(cwd),
            mtimeMs: Date.parse(`2026-01-0${index + 1}T00:00:00.000Z`),
          });
        }

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(
          result.candidates.map((candidate) => ({ path: candidate.path, git: candidate.git })),
        ).toEqual([
          {
            path: submodule,
            git: {
              remoteKey: "gitlab.com/pingdotgg/libs/vendor",
              repository: "pingdotgg/libs/vendor",
            },
          },
          { path: noRemote, git: { remoteKey: null, repository: null } },
          { path: plain, git: null },
          {
            path: repo,
            git: { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" },
          },
        ]);
      }),
    );

    it.effect(
      "offers bare-repository worktrees separately and imports only their own sessions",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
          yield* TestClock.setTime(nowMs);
          const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
          const codexHomePath = yield* makeTempDir("t3code-codex-home-");
          const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
          const bare = yield* makeTempDir("t3code-workspace-bare-");
          const bareGitDir = path.join(bare, ".git");
          yield* fileSystem.makeDirectory(bareGitDir);
          yield* fileSystem.writeFileString(
            path.join(bareGitDir, "config"),
            '[core] bare = "true" ; bare repository\n[remote "origin"]\nurl = git@github.com:pingdotgg/t3code.git\n',
          );
          const dev = path.join(bare, "dev");
          const prod = path.join(bare, "prod");
          const managed = path.join(configBaseDir, "worktrees", "t3code", "sandbox");
          for (const [index, cwd] of [bare, dev, prod, managed].entries()) {
            if (cwd !== bare) {
              const gitDir = path.join(bareGitDir, "worktrees", path.basename(cwd));
              yield* fileSystem.makeDirectory(gitDir, { recursive: true });
              yield* fileSystem.writeFileString(path.join(gitDir, "commondir"), "../..\n");
              yield* fileSystem.makeDirectory(cwd, { recursive: true });
              yield* fileSystem.writeFileString(path.join(cwd, ".git"), `gitdir: ${gitDir}\n`);
            }
            yield* writeTranscript({
              filePath: path.join(
                codexHomePath,
                "sessions",
                "2026",
                "08",
                "24",
                `rollout-${index}.jsonl`,
              ),
              contents: [
                encodeTranscriptRecord({
                  type: "session_meta",
                  payload: { id: `session-${index}`, cwd },
                }),
                encodeTranscriptRecord({
                  type: "event_msg",
                  payload: { type: "user_message", message: `Work in ${cwd}` },
                }),
              ].join("\n"),
              mtimeMs: nowMs - index * 1_000,
            });
          }

          const input = { claudeHomePath, codexHomePath, configBaseDir };
          const result = yield* runScan(input);
          const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
          expect(
            result.candidates.map((candidate) => ({ path: candidate.path, git: candidate.git })),
          ).toEqual([
            { path: bare, git },
            { path: dev, git },
            { path: prod, git },
          ]);
          const threads = yield* runRecentThreads({ ...input, workspaceRoot: dev });
          expect(threads.map((thread) => thread.providerSessionId)).toEqual(["session-1"]);
          const managedThreads = yield* runRecentThreads({ ...input, workspaceRoot: managed });
          expect(managedThreads).toEqual([]);
        }),
    );

    it.effect("excludes sandboxes under the configured worktrees dir without .t3 in the path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
        const fileSystem = yield* FileSystem.FileSystem;

        const worktreeCwd = path.join(configBaseDir, "worktrees", "t3code", "wt-2");
        yield* fileSystem.makeDirectory(worktreeCwd, { recursive: true });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(worktreeCwd),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath, configBaseDir });

        expect(result.candidates).toEqual([]);
      }),
    );

    it.effect("excludes sandboxes reached through a symlink into the worktrees dir", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
        const linkParent = yield* makeTempDir("t3code-scanner-links-");
        const fileSystem = yield* FileSystem.FileSystem;

        const worktreeCwd = path.join(configBaseDir, "worktrees", "t3code", "wt-3");
        yield* fileSystem.makeDirectory(worktreeCwd, { recursive: true });
        const symlinkCwd = path.join(linkParent, "innocent-project");
        yield* fileSystem.symlink(worktreeCwd, symlinkCwd);
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(symlinkCwd),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath, configBaseDir });

        expect(result.candidates).toEqual([]);
      }),
    );

    it.effect("finds the cwd on a later line when the first records carry none", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        const contents = `{"type":"file-history-snapshot","messageId":"m1"}\n{"type":"queue-operation","operation":"enqueue"}\n${claudeSessionLine(workspace)}`;
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents,
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
      }),
    );

    it.effect("reads a complete transcript record at the exact chunk boundary", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const record = claudeSessionLine(workspace).split("\n")[0]!;
        const prefix = '{"padding":"';
        const suffix = `",${record.slice(1)}`;
        const contents = `${prefix}${"x".repeat(32 * 1024 - prefix.length - suffix.length)}${suffix}`;

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-exact", "session.jsonl"),
          contents,
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(contents).toHaveLength(32 * 1024);
        expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
      }),
    );

    it.effect("skips malformed transcripts without failing the scan", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-broken", "a.jsonl"),
          contents: "not json at all\n",
          mtimeMs: Date.parse("2026-05-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-no-cwd", "a.jsonl"),
          contents: `{"type":"summary"}\n`,
          mtimeMs: Date.parse("2026-05-02T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-good", "a.jsonl"),
          contents: claudeSessionLine(workspace),
          mtimeMs: Date.parse("2026-05-03T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([
          {
            path: workspace,
            title: path.basename(workspace),
            sources: ["claudeAgent"],
            threadCount: 1,
            lastActiveAt: "2026-05-03T00:00:00.000Z",
            alreadyImported: false,
            git: null,
          },
        ]);
      }),
    );
  });
});
