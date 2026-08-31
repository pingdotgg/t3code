import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** Only `getShellSnapshot` is exercised; the rest must not be called. */
const makeProjectionSnapshotQueryLayer = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
        threads: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
  });

/**
 * Run a scan against the given homes. Homes are temp dirs created inside the
 * test, so the layer is built per run rather than shared.
 */
interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
  /** Base dir for the test ServerConfig; worktreesDir derives from it. */
  readonly configBaseDir?: string;
  readonly providerInstances?: ContractServerSettings["providerInstances"];
}

const makeScannerTestLayer = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providers: {
            claudeAgent: { homePath: input.claudeHomePath },
            codex: { homePath: input.codexHomePath },
          },
          ...(input.providerInstances === undefined
            ? {}
            : { providerInstances: input.providerInstances }),
        }),
        ServerConfig.layerTest(
          input.claudeHomePath,
          input.configBaseDir ?? { prefix: "t3code-scanner-config-" },
        ),
        makeProjectionSnapshotQueryLayer(input.importedWorkspaceRoots ?? []),
      ),
    ),
  );

const runScan = (input: ScannerTestInput) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan;
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const runRecentThreads = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.recentThreads(input.workspaceRoot).pipe(
      Stream.runCollect,
      Effect.map((threads) => Array.from(threads)),
    );
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const makeTempDir = Effect.fn("AgentSessionScanner.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScanner.test.writeTranscript")(function* (input: {
  readonly filePath: string;
  readonly contents: string;
  /** Epoch millis, so ordering assertions never depend on write timing. */
  readonly mtimeMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* fileSystem.writeFileString(input.filePath, input.contents);
  // Numeric utimes arguments are seconds, not milliseconds.
  const seconds = input.mtimeMs / 1000;
  yield* fileSystem.utimes(input.filePath, seconds, seconds);
});

/** Claude session line: the first record carries the real `cwd`. */
const claudeSessionLine = (cwd: string) =>
  `${JSON.stringify({ type: "user", cwd, sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`;

/** Codex rollout line: session metadata is nested under `payload`. */
const codexRolloutLine = (cwd: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd } })}\n`;

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("AgentSessionScanner", (it) => {
  describe("scan", () => {
    it.effect("reads Claude project cwds from transcripts, newest first", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const olderWorkspace = yield* makeTempDir("t3code-workspace-older-");
        const newerWorkspace = yield* makeTempDir("t3code-workspace-newer-");

        // Slugs are intentionally lossy; the scanner must not decode them.
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug-older", "a.jsonl"),
          contents: claudeSessionLine(olderWorkspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug-older", "b.jsonl"),
          contents: claudeSessionLine(olderWorkspace),
          mtimeMs: Date.parse("2026-01-02T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug-newer", "c.jsonl"),
          contents: claudeSessionLine(newerWorkspace),
          mtimeMs: Date.parse("2026-03-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([
          {
            path: newerWorkspace,
            title: path.basename(newerWorkspace),
            sources: ["claudeAgent"],
            threadCount: 1,
            lastActiveAt: "2026-03-01T00:00:00.000Z",
            alreadyImported: false,
          },
          {
            path: olderWorkspace,
            title: path.basename(olderWorkspace),
            sources: ["claudeAgent"],
            threadCount: 2,
            lastActiveAt: "2026-01-02T00:00:00.000Z",
            alreadyImported: false,
          },
        ]);
      }),
    );

    it.effect("groups Codex rollouts by cwd across date directories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const otherWorkspace = yield* makeTempDir("t3code-workspace-other-");

        const rollout = (year: string, month: string, day: string, name: string) =>
          path.join(codexHomePath, "sessions", year, month, day, name);

        yield* writeTranscript({
          filePath: rollout("2026", "01", "05", "rollout-2026-01-05T10-00-00-aaa.jsonl"),
          contents: codexRolloutLine(workspace),
          mtimeMs: Date.parse("2026-01-05T10:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: rollout("2026", "02", "09", "rollout-2026-02-09T10-00-00-bbb.jsonl"),
          contents: codexRolloutLine(workspace),
          mtimeMs: Date.parse("2026-02-09T10:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: rollout("2026", "02", "09", "rollout-2026-02-09T11-00-00-ccc.jsonl"),
          contents: codexRolloutLine(otherWorkspace),
          mtimeMs: Date.parse("2026-02-09T11:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([
          {
            path: otherWorkspace,
            title: path.basename(otherWorkspace),
            sources: ["codex"],
            threadCount: 1,
            lastActiveAt: "2026-02-09T11:00:00.000Z",
            alreadyImported: false,
          },
          {
            path: workspace,
            title: path.basename(workspace),
            sources: ["codex"],
            threadCount: 2,
            lastActiveAt: "2026-02-09T10:00:00.000Z",
            alreadyImported: false,
          },
        ]);
      }),
    );

    it.effect("merges the same cwd seen by both agents and flags imported projects", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(workspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "04",
            "01",
            "rollout-2026-04-01T09-00-00-aaa.jsonl",
          ),
          contents: codexRolloutLine(workspace),
          mtimeMs: Date.parse("2026-04-01T09:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [workspace],
        });

        expect(result.candidates).toEqual([
          {
            path: workspace,
            title: path.basename(workspace),
            projectId: ProjectId.make("project-1"),
            sources: ["claudeAgent", "codex"],
            threadCount: 2,
            lastActiveAt: "2026-04-01T09:00:00.000Z",
            alreadyImported: true,
          },
        ]);
      }),
    );

    it.effect("returns the imported project ID through a realpath alias", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const linkParent = yield* makeTempDir("t3code-scanner-links-");
        const workspaceAlias = path.join(linkParent, "workspace-alias");
        yield* fileSystem.symlink(workspace, workspaceAlias);

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(workspaceAlias),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [workspace],
        });

        expect(result.candidates[0]).toMatchObject({
          path: workspaceAlias,
          projectId: ProjectId.make("project-1"),
          alreadyImported: true,
        });
      }),
    );

    it.effect("uses explicit provider instance homes instead of overridden legacy homes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-legacy-");
        const codexHomePath = yield* makeTempDir("t3code-codex-legacy-");
        const claudeInstanceHome = yield* makeTempDir("t3code-claude-instance-");
        const codexInstanceHome = yield* makeTempDir("t3code-codex-instance-");
        const legacyWorkspace = yield* makeTempDir("t3code-workspace-legacy-");
        const claudeWorkspace = yield* makeTempDir("t3code-workspace-claude-");
        const codexWorkspace = yield* makeTempDir("t3code-workspace-codex-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-legacy", "session.jsonl"),
          contents: claudeSessionLine(legacyWorkspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeInstanceHome, "projects", "-actual", "session.jsonl"),
          contents: claudeSessionLine(claudeWorkspace),
          mtimeMs: Date.parse("2026-02-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(
            codexInstanceHome,
            "sessions",
            "2026",
            "03",
            "01",
            "rollout-instance.jsonl",
          ),
          contents: codexRolloutLine(codexWorkspace),
          mtimeMs: Date.parse("2026-03-01T00:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeInstanceHome },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: codexInstanceHome },
            },
          },
        });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
          codexWorkspace,
          claudeWorkspace,
        ]);
      }),
    );

    it.effect("scans each distinct home across multiple instances once", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const otherCodexHome = yield* makeTempDir("t3code-codex-other-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const otherWorkspace = yield* makeTempDir("t3code-workspace-other-");

        for (const [home, cwd] of [
          [codexHomePath, workspace],
          [otherCodexHome, otherWorkspace],
        ] as const) {
          yield* writeTranscript({
            filePath: path.join(home, "sessions", "2026", "01", "01", "rollout-session.jsonl"),
            contents: codexRolloutLine(cwd),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          });
        }

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("codex-personal")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: codexHomePath },
            },
            [ProviderInstanceId.make("codex-work")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: otherCodexHome },
            },
          },
        });

        expect(result.candidates).toHaveLength(2);
        expect(result.candidates.map((candidate) => candidate.threadCount)).toEqual([1, 1]);
        expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual(
          [workspace, otherWorkspace].sort(),
        );
      }),
    );

    it.effect("honors provider instance home directory environment variables", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-legacy-");
        const codexHomePath = yield* makeTempDir("t3code-codex-legacy-");
        const claudeEnvironmentHome = yield* makeTempDir("t3code-claude-env-");
        const codexEnvironmentHome = yield* makeTempDir("t3code-codex-env-");
        const claudeWorkspace = yield* makeTempDir("t3code-workspace-claude-");
        const codexWorkspace = yield* makeTempDir("t3code-workspace-codex-");

        yield* writeTranscript({
          filePath: path.join(claudeEnvironmentHome, "projects", "-actual", "session.jsonl"),
          contents: claudeSessionLine(claudeWorkspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(
            codexEnvironmentHome,
            "sessions",
            "2026",
            "01",
            "01",
            "rollout-session.jsonl",
          ),
          contents: codexRolloutLine(codexWorkspace),
          mtimeMs: Date.parse("2026-01-02T00:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: claudeEnvironmentHome, sensitive: false },
              ],
              config: {},
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "CODEX_HOME", value: codexEnvironmentHome, sensitive: false }],
              config: {},
            },
          },
        });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
          codexWorkspace,
          claudeWorkspace,
        ]);
      }),
    );

    it.effect("ignores invalid provider instances while scanning the remaining providers", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-actual", "session.jsonl"),
          contents: claudeSessionLine(workspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: 123 },
            },
          },
        });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
      }),
    );

    it.effect("ignores relative working directories from malformed transcripts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-relative", "session.jsonl"),
          contents: claudeSessionLine(path.relative(path.resolve(), workspace)),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates).toEqual([]);
      }),
    );

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

    it.effect("excludes sandboxes under the configured worktrees dir without .t3 in the path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
        const fileSystem = yield* FileSystem.FileSystem;

        // worktreesDir derives as `<baseDir>/worktrees`, and the temp base
        // dir contains no `.t3` segment — only the config-based prefix match
        // can exclude this one.
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

        // The recorded cwd is a symlink whose own spelling looks harmless;
        // only its realpath reveals the managed sandbox.
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

        // Claude transcripts often open with records that have no cwd.
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

    it.effect("finds session metadata after a first record larger than one chunk", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const history = `{"type":"file-history-snapshot","data":"${"x".repeat(32 * 1024)}"}\n`;

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-large", "session.jsonl"),
          contents: `${history}${claudeSessionLine(workspace)}`,
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

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
        // Valid JSON, but no cwd anywhere in the record.
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
          },
        ]);
      }),
    );

    it.effect("returns an empty result when neither home directory exists", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir("t3code-missing-homes-");

        const result = yield* runScan({
          claudeHomePath: path.join(root, "no-claude"),
          codexHomePath: path.join(root, "no-codex"),
        });

        expect(result.candidates).toEqual([]);
        expect(result.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }),
    );
  });

  describe("recentThreads", () => {
    it.effect("imports recent Claude and Codex sessions for the selected project only", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const otherWorkspace = yield* makeTempDir("t3code-workspace-other-");

        const claudeTranscript = (cwd: string, sessionId: string) =>
          `${JSON.stringify({
            type: "user",
            cwd,
            sessionId,
            timestamp: "2026-08-23T12:00:00.000Z",
            message: { role: "user", content: "Fix the project" },
          })}\n${JSON.stringify({
            type: "assistant",
            sessionId,
            timestamp: "2026-08-23T12:01:00.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
          })}\n`;

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-recent.jsonl"),
          contents: claudeTranscript(workspace, "claude-recent"),
          mtimeMs: nowMs - 24 * 60 * 60 * 1000,
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-selected", "claude-old.jsonl"),
          contents: claudeTranscript(workspace, "claude-old"),
          mtimeMs: nowMs - 31 * 24 * 60 * 60 * 1000,
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-other", "claude-other.jsonl"),
          contents: claudeTranscript(otherWorkspace, "claude-other"),
          mtimeMs: nowMs - 24 * 60 * 60 * 1000,
        });
        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "08",
            "24",
            "rollout-codex-recent.jsonl",
          ),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "codex-recent", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              timestamp: "2026-08-24T10:00:00.000Z",
              payload: { type: "user_message", message: "Review this code" },
            }),
            encodeTranscriptRecord({
              type: "response_item",
              timestamp: "2026-08-24T10:01:00.000Z",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Looks good" }],
              },
            }),
          ].join("\n"),
          mtimeMs: nowMs - 60 * 60 * 1000,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(threads.map((thread) => thread.providerSessionId)).toEqual([
          "codex-recent",
          "claude-recent",
        ]);
        expect(threads.map((thread) => thread.messages.map((message) => message.text))).toEqual([
          ["Review this code", "Looks good"],
          ["Fix the project", "Done"],
        ]);
      }),
    );

    it.effect("keeps the provider instance that owns a custom session home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const customHome = yield* makeTempDir("t3code-codex-custom-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(customHome, "sessions", "2026", "08", "24", "rollout-custom.jsonl"),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "custom-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Use my work account" },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
          providerInstances: {
            [ProviderInstanceId.make("codex-work")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: customHome },
            },
          },
        });

        expect(threads[0]?.providerInstanceId).toBe("codex-work");
      }),
    );

    it.effect("skips a transcript that grows after its size check", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const transcriptPath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          "rollout-growing.jsonl",
        );
        const grownPath = path.join(codexHomePath, "grown.jsonl");
        const contents = [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: "growing-session", cwd: workspace },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message: "Do not import a changing file" },
          }),
        ].join("\n");
        yield* writeTranscript({ filePath: transcriptPath, contents, mtimeMs: nowMs });
        yield* writeTranscript({
          filePath: grownPath,
          contents: `${contents}\nchanged`,
          mtimeMs: nowMs,
        });

        let transcriptOpenCount = 0;
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) => {
            if (filePath !== transcriptPath) return fileSystem.open(filePath, options);
            transcriptOpenCount += 1;
            return fileSystem.open(transcriptOpenCount === 1 ? transcriptPath : grownPath, options);
          },
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(transcriptOpenCount).toBe(2);
        expect(threads).toEqual([]);
      }),
    );

    it.effect("does not read the second transcript when the consumer takes one thread", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const makeCodexTranscript = (sessionId: string, text: string) =>
          [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: sessionId, cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: text },
            }),
          ].join("\n");
        const olderPath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "23",
          "rollout-older.jsonl",
        );
        const newerPath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          "rollout-newer.jsonl",
        );
        yield* writeTranscript({
          filePath: olderPath,
          contents: makeCodexTranscript("older-session", "Older prompt"),
          mtimeMs: nowMs - 1_000,
        });
        yield* writeTranscript({
          filePath: newerPath,
          contents: makeCodexTranscript("newer-session", "Newer prompt"),
          mtimeMs: nowMs,
        });

        const openCounts = new Map<string, number>();
        const contentReads: Array<string> = [];
        const trackedPaths = new Set([olderPath, newerPath]);
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) => {
            if (trackedPaths.has(filePath)) {
              const count = (openCounts.get(filePath) ?? 0) + 1;
              openCounts.set(filePath, count);
              if (count === 2) contentReads.push(filePath);
            }
            return fileSystem.open(filePath, options);
          },
        });

        const threads = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          return yield* scanner.recentThreads(workspace).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          );
        }).pipe(
          Effect.provide(makeScannerTestLayer({ claudeHomePath, codexHomePath })),
          Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
        );

        expect(threads.map((thread) => thread.providerSessionId)).toEqual(["newer-session"]);
        expect(contentReads).toEqual([newerPath]);
        expect(openCounts.get(olderPath)).toBe(1);
      }),
    );

    it.effect("does not import sessions from a T3-managed worktree", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const configBaseDir = yield* makeTempDir("t3code-scanner-base-");
        const workspace = path.join(configBaseDir, "worktrees", "t3code", "managed-worktree");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });

        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "08",
            "24",
            "rollout-managed.jsonl",
          ),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "managed-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Do not import this session" },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          configBaseDir,
          workspaceRoot: workspace,
        });

        expect(threads).toEqual([]);
      }),
    );

    it.effect("keeps every provider instance associated with a shared session home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(sharedHome, "sessions", "2026", "08", "24", "rollout-shared.jsonl"),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "shared-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Use the shared session" },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
          providerInstances: {
            [ProviderInstanceId.make("codex-personal")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: sharedHome },
            },
            [ProviderInstanceId.make("codex-work")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: sharedHome },
            },
          },
        });

        expect(threads.map((thread) => thread.providerInstanceId).sort()).toEqual([
          "codex-personal",
          "codex-work",
        ]);
      }),
    );

    it.effect(
      "finds recent Claude sessions after an older directory exhausts the read budget",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
          yield* TestClock.setTime(nowMs);
          const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
          const codexHomePath = yield* makeTempDir("t3code-codex-home-");
          const oldWorkspace = yield* makeTempDir("t3code-workspace-old-");
          const recentWorkspace = yield* makeTempDir("t3code-workspace-recent-");
          const oldDirectory = path.join(claudeHomePath, "projects", "-aaa-old");
          const oldTranscript = path.join(oldDirectory, "old.jsonl");
          const recentDirectory = path.join(claudeHomePath, "projects", "-zzz-recent");

          yield* writeTranscript({
            filePath: oldTranscript,
            contents: encodeTranscriptRecord({
              type: "user",
              cwd: oldWorkspace,
              sessionId: "old-session",
              message: { role: "user", content: "Old work" },
            }),
            mtimeMs: nowMs - 45 * 24 * 60 * 60 * 1000,
          });
          yield* writeTranscript({
            filePath: path.join(recentDirectory, "recent.jsonl"),
            contents: encodeTranscriptRecord({
              type: "user",
              cwd: recentWorkspace,
              sessionId: "recent-session",
              message: { role: "user", content: "Recent work" },
            }),
            mtimeMs: nowMs,
          });

          const simulatedOldTranscripts = Array.from(
            { length: 5_000 },
            (_, index) => `old-${index}.jsonl`,
          );
          const resolveTranscript = (filePath: string) =>
            path.dirname(filePath) === oldDirectory && path.basename(filePath).startsWith("old-")
              ? oldTranscript
              : filePath;
          const simulatedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directory, options) =>
              directory === oldDirectory
                ? Effect.succeed(simulatedOldTranscripts)
                : fileSystem.readDirectory(directory, options),
            stat: (filePath) => fileSystem.stat(resolveTranscript(filePath)),
            open: (filePath, options) => fileSystem.open(resolveTranscript(filePath), options),
          });

          const threads = yield* runRecentThreads({
            claudeHomePath,
            codexHomePath,
            workspaceRoot: recentWorkspace,
          }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

          expect(threads.map((thread) => thread.providerSessionId)).toEqual(["recent-session"]);
        }),
    );
  });
});

describe("parseAgentSessionTranscript", () => {
  it("keeps Claude text and titles while dropping malformed and tool records", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        "not valid json",
        JSON.stringify({ type: "ai-title", aiTitle: "Fix authentication" }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          isMeta: true,
          message: { role: "user", content: "Injected skill instructions" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          isCompactSummary: true,
          message: { role: "user", content: "Injected compaction summary" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          timestamp: "2026-08-24T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Fix authentication" }] },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          message: { role: "user", content: [{ type: "tool_result", text: "hidden" }] },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "Updated the login flow" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "The provider request failed" }],
          },
        }),
      ].join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toMatchObject({
      providerSessionId: "claude-session",
      title: "Fix authentication",
      model: "claude-sonnet-5",
      messages: [
        { role: "user", text: "Fix authentication" },
        { role: "assistant", text: "Updated the login flow" },
        { role: "assistant", text: "The provider request failed" },
      ],
    });
  });

  it("drops injected Codex instructions while keeping the visible user event", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<user_instructions>\nInternal setup instructions\n</user_instructions>",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Fix the actual bug" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Fixed" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Fix the actual bug",
      "Fixed",
    ]);
  });

  it("keeps distinct Codex response user messages in mixed-format transcripts", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep this older prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Keep this newer prompt" },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep this newer prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Ask again when needed" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep this newer prompt" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Keep this older prompt",
      "Keep this newer prompt",
      "Ask again when needed",
      "Keep this newer prompt",
    ]);
  });

  it("uses the first valid Codex session ID when a fork copies ancestor metadata", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({
          type: "session_meta",
          payload: { id: "fork-session", forked_from_id: "parent-session" },
        }),
        encodeTranscriptRecord({
          type: "session_meta",
          payload: { id: "parent-session" },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Continue in the fork" },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.providerSessionId).toBe("fork-session");
  });

  it("skips Codex transcripts without a resumable session ID", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: encodeTranscriptRecord({
        type: "event_msg",
        payload: { type: "user_message", message: "This transcript has no session metadata" },
      }),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "rollout-2026-08-24T12-00-00-not-a-session-id",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toBeNull();
  });

  it("removes injected Codex environment records before choosing the thread title", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message:
              "<environment_context>\n<cwd>/tmp/project</cwd>\n<shell>zsh</shell>\n</environment_context>",
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message:
              "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nPrivate project rules\n</INSTRUCTIONS>",
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Do something here so it looks like a real project.",
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Created the project." }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Do something here so it looks like a real project.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Do something here so it looks like a real project.",
      "Created the project.",
    ]);
  });

  it("removes injected Codex context from fallback response messages", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>",
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Initialize Git and add a README." }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Initialize Git and add a README.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Initialize Git and add a README.",
    ]);
  });

  it("preserves a real prompt that follows injected context in the same Codex message", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message:
              "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\n\nCreate a useful project.",
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Create a useful project.");
    expect(thread?.messages.map((message) => message.text)).toEqual(["Create a useful project."]);
  });

  it("removes the Codex request heading after leading injected context", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "\n  ## My request for Codex:\n\nFix the visible bug",
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Fix the visible bug");
    expect(thread?.messages.map((message) => message.text)).toEqual(["Fix the visible bug"]);
  });

  it("keeps context markup quoted inside visible Codex user text", () => {
    const quoted =
      "Do not remove this example:\n<environment_context>\n<cwd>/tmp/example</cwd>\n</environment_context>";
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: quoted },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([quoted]);
  });

  it("skips sessions without a visible user message", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Done" },
      }),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "claude-session",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toBeNull();
  });

  it("keeps the first prompt when later assistant output exceeds the message limit", () => {
    const transcript = [
      encodeTranscriptRecord({
        type: "user",
        sessionId: "claude-session",
        message: { role: "user", content: "Keep this prompt" },
      }),
      ...Array.from({ length: 250 }, (_, index) =>
        encodeTranscriptRecord({
          type: "assistant",
          message: { role: "assistant", content: `Assistant update ${index}` },
        }),
      ),
    ].join("\n");

    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: transcript,
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]?.text).toBe("Keep this prompt");
    expect(thread?.messages.at(-1)?.text).toBe("Assistant update 249");
  });
});
