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


describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "AgentSessionScanner scan with a git config open() that never returns",
  () => {
    it.effect(
      "completes every scan and leaves the libuv pool free when .git/config is a FIFO",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
          const codexHomePath = yield* makeTempDir("t3code-codex-home-");
          const repo = yield* makeTempDir("t3code-workspace-fifo-config-");
          yield* fileSystem.makeDirectory(path.join(repo, ".git"));
          yield* makeOpenGate(path.join(repo, ".git", "config"));
          const transcriptPath = path.join(claudeHomePath, "projects", "-fifo", "a.jsonl");
          yield* writeTranscript({
            filePath: transcriptPath,
            contents: claudeSessionLine(repo),
            mtimeMs: Date.parse("2026-05-03T00:00:00.000Z"),
          });

          for (let attempt = 1; attempt <= LIBUV_POOL_SIZE + 1; attempt++) {
            const scan = yield* Effect.forkChild(
              runScan({ claudeHomePath, codexHomePath }).pipe(
                Effect.map(({ candidates }) => candidates.map(({ path }) => path)),
              ),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* awaitGateReader(path.join(repo, ".git", "config"));
                yield* TestClock.adjust("2 seconds");
                expect(yield* Fiber.join(scan), `scan ${attempt}`).toEqual([repo]);
              }),
            );
          }
          // Hangs if the scans left libuv pool threads stuck in open().
          yield* fileSystem.readFileString(transcriptPath);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("still reads the git identity of repositories next to a blocked one", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const repos = [
          yield* makeTempDir("t3code-workspace-before-"),
          yield* makeTempDir("t3code-workspace-blocked-"),
          yield* makeTempDir("t3code-workspace-after-"),
        ] as const;
        for (const [index, repo] of repos.entries()) {
          yield* fileSystem.makeDirectory(path.join(repo, ".git"));
          const configPath = path.join(repo, ".git", "config");
          if (index === 1) yield* makeOpenGate(configPath);
          else
            yield* fileSystem.writeFileString(
              configPath,
              `[remote "origin"]\n\turl = git@github.com:pingdotgg/repo-${index}.git\n`,
            );
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, "a.jsonl"),
            contents: claudeSessionLine(repo),
            mtimeMs: Date.parse(`2026-01-0${index + 1}T00:00:00.000Z`),
          });
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
          const scan = yield* Effect.forkChild(runScan({ claudeHomePath, codexHomePath }));
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* awaitGateReader(path.join(repos[1], ".git", "config"));
              yield* TestClock.adjust("2 seconds");
              return yield* Fiber.join(scan);
            }),
          );
          expect(
            result.candidates.map((candidate) => ({ path: candidate.path, git: candidate.git })),
            `scan ${attempt}`,
          ).toEqual([
            {
              path: repos[2],
              git: { remoteKey: "github.com/pingdotgg/repo-2", repository: "pingdotgg/repo-2" },
            },
            { path: repos[1], git: { remoteKey: null, repository: null } },
            {
              path: repos[0],
              git: { remoteKey: "github.com/pingdotgg/repo-0", repository: "pingdotgg/repo-0" },
            },
          ]);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("reads every blocked git config of a scan under one deadline", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const root = yield* makeTempDir("t3code-workspace-blocked-configs-");
        const repos = [path.join(root, "repo-a"), path.join(root, "repo-b")];
        for (const repo of repos) {
          yield* fileSystem.makeDirectory(path.join(repo, ".git"), { recursive: true });
          yield* makeOpenGate(path.join(repo, ".git", "config"));
        }
        // Two linked worktrees of one bare repository share its blocked config.
        const bareGitDir = path.join(root, "bare.git");
        yield* fileSystem.makeDirectory(bareGitDir);
        yield* makeOpenGate(path.join(bareGitDir, "config"));
        const worktrees = [path.join(root, "wt-1"), path.join(root, "wt-2")];
        for (const worktree of worktrees) {
          const gitDir = path.join(bareGitDir, "worktrees", path.basename(worktree));
          yield* fileSystem.makeDirectory(gitDir, { recursive: true });
          yield* fileSystem.writeFileString(path.join(gitDir, "commondir"), "../..\n");
          yield* fileSystem.makeDirectory(worktree);
          yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
        }
        for (const [index, cwd] of [...repos, ...worktrees].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, "a.jsonl"),
            contents: claudeSessionLine(cwd),
            mtimeMs: Date.parse(`2026-01-0${index + 1}T00:00:00.000Z`),
          });
        }

        const scan = yield* Effect.forkChild(
          runScan({ claudeHomePath, codexHomePath }).pipe(
            Effect.map(({ candidates }) => candidates.map(({ path }) => path).toSorted()),
          ),
        );
        // Every blocked config is open before any deadline passes; reading them
        // one after another would leave the later ones unopened.
        yield* Effect.forEach(
          [...repos.map((repo) => path.join(repo, ".git")), bareGitDir],
          (gitDir) => awaitGateReader(path.join(gitDir, "config")),
          { concurrency: "unbounded" },
        );
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(scan)).toEqual(repos);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("completes every scan when a .git pointer file or commondir never opens", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const root = yield* makeTempDir("t3code-workspace-blocked-pointers-");
        const pointerCheckout = path.join(root, "pointer");
        yield* fileSystem.makeDirectory(pointerCheckout);
        yield* makeOpenGate(path.join(pointerCheckout, ".git"));
        const worktree = path.join(root, "worktree");
        const worktreeGitDir = path.join(root, "main", ".git", "worktrees", "worktree");
        yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
        yield* makeOpenGate(path.join(worktreeGitDir, "commondir"));
        yield* fileSystem.makeDirectory(worktree);
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${worktreeGitDir}\n`,
        );
        for (const [index, cwd] of [pointerCheckout, worktree].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, "a.jsonl"),
            contents: claudeSessionLine(cwd),
            mtimeMs: Date.parse(`2026-01-0${index + 1}T00:00:00.000Z`),
          });
        }

        // One scanner across scans: later scans skip the files that blocked.
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const scanPaths = scanner.scan.pipe(
            Effect.map(({ candidates }) => candidates.map(({ path }) => path)),
          );
          const first = yield* Effect.forkChild(scanPaths);
          // Pointer files are read first, then the commondir files they lead to.
          for (const gatePath of [
            path.join(pointerCheckout, ".git"),
            path.join(worktreeGitDir, "commondir"),
          ]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* awaitGateReader(gatePath);
                yield* TestClock.adjust("2 seconds");
              }),
            );
          }
          expect(yield* Fiber.join(first)).toEqual([pointerCheckout]);
          for (let attempt = 2; attempt <= LIBUV_POOL_SIZE + 1; attempt++) {
            expect(yield* scanPaths, `scan ${attempt}`).toEqual([pointerCheckout]);
          }
        }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })));
        // Hangs if the scans left libuv pool threads stuck in open().
        yield* fileSystem.readFileString(path.join(worktree, ".git"));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("reads a once-blocked git config again after the retry interval", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const repo = yield* makeTempDir("t3code-workspace-unblocked-config-");
        yield* fileSystem.makeDirectory(path.join(repo, ".git"));
        const configPath = path.join(repo, ".git", "config");
        yield* makeOpenGate(configPath);
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-unblocked", "a.jsonl"),
          contents: claudeSessionLine(repo),
          mtimeMs: Date.parse("2026-05-03T00:00:00.000Z"),
        });
        const gitOfScan = (scan: AgentSessionScanner.AgentSessionScanner["Service"]["scan"]) =>
          scan.pipe(Effect.map(({ candidates }) => candidates.map(({ git }) => git)));

        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const blockedScan = yield* Effect.forkChild(gitOfScan(scanner.scan));
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* awaitGateReader(configPath);
              yield* TestClock.adjust("2 seconds");
              expect(yield* Fiber.join(blockedScan)).toEqual([
                { remoteKey: null, repository: null },
              ]);
            }),
          );

          yield* fileSystem.remove(configPath);
          yield* fileSystem.writeFileString(
            configPath,
            `[remote "origin"]\n\turl = git@github.com:pingdotgg/unblocked.git\n`,
          );
          expect(yield* gitOfScan(scanner.scan), "a blocked path is skipped for a while").toEqual([
            { remoteKey: null, repository: null },
          ]);

          yield* TestClock.adjust("10 minutes");
          expect(yield* gitOfScan(scanner.scan)).toEqual([
            { remoteKey: "github.com/pingdotgg/unblocked", repository: "pingdotgg/unblocked" },
          ]);
        }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
