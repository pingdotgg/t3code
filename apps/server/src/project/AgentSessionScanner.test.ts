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
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
    getUserInputActivity: () => Effect.die("unused"),
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
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.succeed([]),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
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

const runRecentThreadOutcomes = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.recentThreads(input.workspaceRoot).pipe(
      Stream.runCollect,
      Effect.map((outcomes) => Array.from(outcomes)),
    );
  }).pipe(Effect.provide(makeScannerTestLayer(input)));

const runRecentThreads = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  runRecentThreadOutcomes(input).pipe(
    Effect.map((outcomes) =>
      outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : [])),
    ),
  );

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

function makeRecordLimitTranscript(cwd: string, overflow: boolean): string {
  const records =
    [
      encodeTranscriptRecord({
        type: "session_meta",
        payload: { id: "record-limit-session", cwd },
      }),
      encodeTranscriptRecord({
        type: "event_msg",
        payload: { type: "user_message", message: "First prompt" },
      }),
    ].join("\n") +
    "\n" +
    "{}\n".repeat(99_998);
  return overflow
    ? records +
        "\n" +
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Overflow prompt" },
        }) +
        "\n"
    : records;
}

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

    it.effect.each(["claudeAgent", "codex"] as const)(
      "does not open a non-file %s transcript",
      (source) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
          const codexHomePath = yield* makeTempDir("t3code-codex-home-");
          const transcriptPath =
            source === "claudeAgent"
              ? path.join(claudeHomePath, "projects", "-slug", "session.jsonl")
              : path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-session.jsonl");
          yield* fileSystem.makeDirectory(transcriptPath, { recursive: true });

          let transcriptOpenCount = 0;
          const simulatedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            open: (filePath, options) => {
              if (filePath === transcriptPath) transcriptOpenCount += 1;
              return fileSystem.open(filePath, options);
            },
          });

          const result = yield* runScan({ claudeHomePath, codexHomePath }).pipe(
            Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
          );

          expect(result.candidates).toEqual([]);
          expect(transcriptOpenCount).toBe(0);
        }),
    );

    it.effect.each(["claudeAgent", "codex"] as const)(
      "stops %s directory reads at the discovery operation budget",
      (source) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
          const codexHomePath = yield* makeTempDir("t3code-codex-home-");
          const discoveryRoot =
            source === "claudeAgent"
              ? path.join(claudeHomePath, "projects")
              : path.join(codexHomePath, "sessions");
          const emptyDirectories = Array.from(
            { length: 20_001 },
            (_, index) => `empty-${index.toString().padStart(5, "0")}`,
          );
          let directoryReadCount = 0;
          const simulatedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directory, options) => {
              if (directory === discoveryRoot) {
                directoryReadCount += 1;
                return Effect.succeed(emptyDirectories);
              }
              if (path.dirname(directory) === discoveryRoot) {
                directoryReadCount += 1;
                return Effect.succeed([]);
              }
              return fileSystem.readDirectory(directory, options);
            },
          });

          const result = yield* runScan({ claudeHomePath, codexHomePath }).pipe(
            Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
          );

          expect(result.candidates).toEqual([]);
          expect(directoryReadCount).toBe(20_000);
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
          path: workspace,
          projectId: ProjectId.make("project-1"),
          alreadyImported: true,
        });
      }),
    );

    it.effect("matches a persisted project alias to a transcript realpath", () =>
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
          contents: claudeSessionLine(workspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [workspaceAlias],
        });

        expect(result.candidates[0]).toMatchObject({
          path: workspaceAlias,
          projectId: ProjectId.make("project-1"),
          alreadyImported: true,
        });
      }),
    );

    it.effect("merges case aliases and preserves the persisted project path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const workspaceAlias = path.join(
          path.dirname(workspace),
          path.basename(workspace).toUpperCase(),
        );

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "a.jsonl"),
          contents: claudeSessionLine(workspaceAlias),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "01", "02", "rollout-b.jsonl"),
          contents: codexRolloutLine(workspace),
          mtimeMs: Date.parse("2026-01-02T00:00:00.000Z"),
        });

        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) => fileSystem.stat(filePath === workspaceAlias ? workspace : filePath),
        });
        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [workspace],
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(result.candidates).toEqual([
          {
            path: workspace,
            title: path.basename(workspace),
            projectId: ProjectId.make("project-1"),
            sources: ["claudeAgent", "codex"],
            threadCount: 2,
            lastActiveAt: "2026-01-02T00:00:00.000Z",
            alreadyImported: true,
          },
        ]);
      }),
    );

    it.effect("keeps case variants distinct when the filesystem identities differ", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const backingUpper = yield* makeTempDir("t3code-backing-upper-");
        const backingLower = yield* makeTempDir("t3code-backing-lower-");
        const aliasParent = yield* makeTempDir("t3code-case-aliases-");
        const upperWorkspace = path.join(aliasParent, "Repo");
        const lowerWorkspace = path.join(aliasParent, "repo");

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-upper", "a.jsonl"),
          contents: claudeSessionLine(upperWorkspace),
          mtimeMs: Date.parse("2026-01-02T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-lower", "b.jsonl"),
          contents: claudeSessionLine(lowerWorkspace),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) =>
            fileSystem.stat(
              filePath === upperWorkspace
                ? backingUpper
                : filePath === lowerWorkspace
                  ? backingLower
                  : filePath,
            ),
        });
        const result = yield* runScan({ claudeHomePath, codexHomePath }).pipe(
          Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
        );

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
          upperWorkspace,
          lowerWorkspace,
        ]);
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

    it.effect("does not scan provider instances disabled by the envelope or config", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const envelopeDisabledHome = yield* makeTempDir("t3code-codex-disabled-envelope-");
        const configDisabledHome = yield* makeTempDir("t3code-codex-disabled-config-");
        const envelopeWorkspace = yield* makeTempDir("t3code-workspace-disabled-envelope-");
        const configWorkspace = yield* makeTempDir("t3code-workspace-disabled-config-");

        for (const [home, workspace, session] of [
          [envelopeDisabledHome, envelopeWorkspace, "envelope-disabled"],
          [configDisabledHome, configWorkspace, "config-disabled"],
        ] as const) {
          yield* writeTranscript({
            filePath: path.join(home, "sessions", "2026", "08", "24", `rollout-${session}.jsonl`),
            contents: codexRolloutLine(workspace),
            mtimeMs: Date.parse("2026-08-24T12:00:00.000Z"),
          });
        }

        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("codex-envelope-disabled")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: { homePath: envelopeDisabledHome },
            },
            [ProviderInstanceId.make("codex-config-disabled")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { enabled: false, homePath: configDisabledHome },
            },
          },
        });

        expect(result.candidates).toEqual([]);
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

    it.effect.each([64, 65])("shares metadata bytes across homes for %s one-MiB files", (count) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-metadata-home-");
        const secondHome = yield* makeTempDir("t3code-metadata-second-");
        const codexHomePath = yield* makeTempDir("t3code-metadata-codex-");
        const firstWorkspace = yield* makeTempDir("t3code-metadata-first-project-");
        const secondWorkspace = yield* makeTempDir("t3code-metadata-second-project-");
        const directories = [
          path.join(claudeHomePath, "projects", "p"),
          path.join(secondHome, "projects", "p"),
        ];
        const templates = directories.map((directory) => path.join(directory, "template.jsonl"));
        for (const [index, workspace] of [firstWorkspace, secondWorkspace].entries()) {
          const record = encodeTranscriptRecord({ cwd: workspace });
          yield* writeTranscript({
            filePath: templates[index]!,
            contents:
              " ".repeat(1024 * 1024 - new TextEncoder().encode(record).byteLength) + record,
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z") - index * 1_000,
          });
        }
        const resolveFile = (filePath: string) => {
          const index = directories.indexOf(path.dirname(filePath));
          return index === -1 ? filePath : templates[index]!;
        };
        let reservedBytes = 0;
        let opens = 0;
        const requests: number[] = [];
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (directory, options) => {
            const index = directories.indexOf(directory);
            return index === -1
              ? fileSystem.readDirectory(directory, options)
              : Effect.succeed(
                  Array.from(
                    { length: index === 0 ? 32 : count - 32 },
                    (_, item) => `session-${item}.jsonl`,
                  ),
                );
          },
          stat: (filePath) => fileSystem.stat(resolveFile(filePath)),
          open: (filePath, options) => {
            if (!directories.includes(path.dirname(filePath)))
              return fileSystem.open(filePath, options);
            opens += 1;
            return fileSystem.open(resolveFile(filePath), options).pipe(
              Effect.map((file) => ({
                ...file,
                stat: file.stat,
                readAlloc: (size: FileSystem.SizeInput) => {
                  reservedBytes += Number(size);
                  requests.push(Number(size));
                  return file.readAlloc(size);
                },
              })),
            );
          },
        });
        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("claude-work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: secondHome },
            },
          },
        }).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));
        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
          firstWorkspace,
          secondWorkspace,
        ]);
        expect(result.candidates.map((candidate) => candidate.threadCount)).toEqual([32, 32]);
        expect(result.truncated).toBe(count === 65 ? true : undefined);
        expect(opens).toBe(64);
        expect(reservedBytes).toBe(64 * 1024 * 1024);
        expect(requests[0]).toBe(8 * 1024);
        expect(Math.max(...requests)).toBe(8 * 1024);
      }),
    );

    it.effect.each([50, 51])("bounds metadata open/read calls for %s short-read files", (count) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-short-metadata-home-");
        const codexHomePath = yield* makeTempDir("t3code-short-metadata-codex-");
        const workspace = yield* makeTempDir("t3code-short-metadata-project-");
        const directory = path.join(claudeHomePath, "projects", "p");
        const template = path.join(directory, "template.jsonl");
        const record = encodeTranscriptRecord({ cwd: workspace });
        const contents = " ".repeat(399 - new TextEncoder().encode(record).byteLength) + record;
        const bytes = new TextEncoder().encode(contents);
        yield* writeTranscript({
          filePath: template,
          contents,
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        let operations = 0;
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (target, options) =>
            target === directory
              ? Effect.succeed(
                  Array.from({ length: count }, (_, index) => `session-${index}.jsonl`),
                )
              : fileSystem.readDirectory(target, options),
          stat: (filePath) =>
            fileSystem.stat(path.dirname(filePath) === directory ? template : filePath),
          open: (filePath, options) => {
            if (path.dirname(filePath) !== directory) return fileSystem.open(filePath, options);
            operations += 1;
            let offset = 0;
            return fileSystem.open(template, options).pipe(
              Effect.map((file) => ({
                ...file,
                stat: file.stat,
                readAlloc: () =>
                  Effect.sync(() => {
                    operations += 1;
                    if (offset === bytes.length) return Option.none<Uint8Array>();
                    return Option.some(bytes.subarray(offset, ++offset));
                  }),
              })),
            );
          },
        });
        const result = yield* runScan({ claudeHomePath, codexHomePath }).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFileSystem),
        );
        expect(operations).toBe(20_000);
        expect(result.candidates[0]?.threadCount).toBe(50);
        expect(result.truncated).toBe(count === 51 ? true : undefined);
      }),
    );

    it.effect("bounds malformed metadata records without excluding another account", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-record-metadata-home-");
        const secondHome = yield* makeTempDir("t3code-record-metadata-second-");
        const codexHomePath = yield* makeTempDir("t3code-record-metadata-codex-");
        const workspace = yield* makeTempDir("t3code-record-metadata-project-");
        const directory = path.join(claudeHomePath, "projects", "p");
        const template = path.join(directory, "template.jsonl");
        yield* writeTranscript({
          filePath: template,
          contents: "x\n".repeat(1_001),
          mtimeMs: Date.parse("2026-01-02T00:00:00.000Z"),
        });
        yield* writeTranscript({
          filePath: path.join(secondHome, "projects", "p", "session.jsonl"),
          contents: encodeTranscriptRecord({ cwd: workspace }),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });
        let malformedOpens = 0;
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readDirectory: (target, options) =>
            target === directory
              ? Effect.succeed(Array.from({ length: 102 }, (_, index) => `session-${index}.jsonl`))
              : fileSystem.readDirectory(target, options),
          stat: (filePath) =>
            fileSystem.stat(path.dirname(filePath) === directory ? template : filePath),
          open: (filePath, options) => {
            if (path.dirname(filePath) !== directory) return fileSystem.open(filePath, options);
            malformedOpens += 1;
            return fileSystem.open(template, options);
          },
        });
        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("claude-work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: secondHome },
            },
          },
        }).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));
        expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
        expect(malformedOpens).toBe(100);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect.each([19_999, 20_000])(
      "reports unfinished directory work for %s project directories",
      (count) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const claudeHomePath = yield* makeTempDir("t3code-directory-budget-home-");
          const codexHomePath = yield* makeTempDir("t3code-directory-budget-codex-");
          const projectsDir = path.join(claudeHomePath, "projects");
          let reads = 0;
          const observedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directory, options) => {
              if (directory === projectsDir) {
                reads += 1;
                return Effect.succeed(
                  Array.from({ length: count }, (_, index) => `project-${index}`),
                );
              }
              if (path.dirname(directory) === projectsDir) {
                reads += 1;
                return Effect.succeed([]);
              }
              return fileSystem.readDirectory(directory, options);
            },
          });
          const result = yield* runScan({ claudeHomePath, codexHomePath }).pipe(
            Effect.provideService(FileSystem.FileSystem, observedFileSystem),
          );
          expect(reads).toBe(20_000);
          expect(result.candidates).toEqual([]);
          expect(result.truncated).toBe(count === 20_000 ? true : undefined);
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
    it.effect.each([false, true])(
      "counts terminal newlines correctly with record overflow=%s",
      (overflow) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
          yield* TestClock.setTime(nowMs);
          const claudeHomePath = yield* makeTempDir("t3code-record-limit-claude-");
          const codexHomePath = yield* makeTempDir("t3code-record-limit-codex-");
          const workspace = yield* makeTempDir("t3code-record-limit-project-");
          const directory = path.join(codexHomePath, "sessions", "2026", "08", "24");
          yield* writeTranscript({
            filePath: path.join(directory, "rollout-records.jsonl"),
            contents: makeRecordLimitTranscript(workspace, overflow),
            mtimeMs: nowMs,
          });
          yield* writeTranscript({
            filePath: path.join(directory, "rollout-older.jsonl"),
            contents: [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: "older-session", cwd: workspace },
              }),
              encodeTranscriptRecord({
                type: "event_msg",
                payload: { type: "user_message", message: "Older prompt" },
              }),
            ].join("\n"),
            mtimeMs: nowMs - 1_000,
          });
          const outcomes = yield* runRecentThreadOutcomes({
            claudeHomePath,
            codexHomePath,
            workspaceRoot: workspace,
          });
          expect(outcomes.map((outcome) => outcome._tag)).toEqual(
            overflow ? ["Skipped", "Importable"] : ["Importable", "Skipped"],
          );
          expect(
            outcomes.flatMap((outcome) =>
              outcome._tag === "Importable"
                ? outcome.thread.messages.map((message) => message.text)
                : [],
            ),
          ).toEqual([overflow ? "Older prompt" : "First prompt"]);
        }),
    );

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

    it.effect("imports history recorded with a case alias", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const workspaceAlias = path.join(
          path.dirname(workspace),
          path.basename(workspace).toUpperCase(),
        );

        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-alias", "case-session.jsonl"),
          contents: [
            encodeTranscriptRecord({
              type: "user",
              cwd: workspaceAlias,
              sessionId: "case-session",
              timestamp: "2026-08-24T10:00:00.000Z",
              message: { role: "user", content: "Import case alias history" },
            }),
            encodeTranscriptRecord({
              type: "assistant",
              sessionId: "case-session",
              timestamp: "2026-08-24T10:01:00.000Z",
              message: { role: "assistant", content: "Imported" },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) => fileSystem.stat(filePath === workspaceAlias ? workspace : filePath),
        });
        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(threads.map((thread) => thread.providerSessionId)).toEqual(["case-session"]);
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

    it.effect("suppresses duplicate session copies without reporting a skipped import", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const contents = [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: "copied-session", cwd: workspace },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message: "Import this session once" },
          }),
        ].join("\n");

        for (const [name, mtimeMs] of [
          ["rollout-copy-a.jsonl", nowMs],
          ["rollout-copy-b.jsonl", nowMs - 1],
        ] as const) {
          yield* writeTranscript({
            filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", name),
            contents,
            mtimeMs,
          });
        }

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Importable", "Duplicate"]);
        expect(outcomes[0]).toMatchObject({
          _tag: "Importable",
          thread: { providerSessionId: "copied-session" },
        });
      }),
    );

    it.effect("shares a 64 MiB full-read budget across providers without hiding projects", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-budget-claude-");
        const codexHomePath = yield* makeTempDir("t3code-budget-codex-");
        const workspace = yield* makeTempDir("t3code-budget-workspace-");
        const transcriptPaths = new Set<string>();
        for (const [index, source] of [
          "codex",
          "claudeAgent",
          "codex",
          "claudeAgent",
          "codex",
        ].entries()) {
          const sessionId = `budget-session-${index}`;
          const filePath =
            source === "codex"
              ? path.join(
                  codexHomePath,
                  "sessions",
                  "2026",
                  "08",
                  "24",
                  `rollout-${sessionId}.jsonl`,
                )
              : path.join(claudeHomePath, "projects", "selected", `${sessionId}.jsonl`);
          const contents =
            source === "codex"
              ? [
                  encodeTranscriptRecord({
                    type: "session_meta",
                    payload: { id: sessionId, cwd: workspace },
                  }),
                  encodeTranscriptRecord({
                    type: "event_msg",
                    payload: { type: "user_message", message: "Imported prompt" },
                  }),
                ].join("\n")
              : encodeTranscriptRecord({
                  type: "user",
                  cwd: workspace,
                  sessionId,
                  message: { content: "Imported prompt" },
                });
          transcriptPaths.add(filePath);
          yield* writeTranscript({
            filePath,
            contents: `${contents}\n`.padEnd(16 * 1024 * 1024, " "),
            mtimeMs: nowMs - index * 1_000,
          });
        }

        const opens = new Map<string, number>();
        let fullReadBytes = 0;
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) => {
            const count = (opens.get(filePath) ?? 0) + 1;
            opens.set(filePath, count);
            return fileSystem.open(filePath, options).pipe(
              Effect.map((file) =>
                !transcriptPaths.has(filePath) || count === 1
                  ? file
                  : {
                      ...file,
                      stat: file.stat,
                      readAlloc: (size: FileSystem.SizeInput) =>
                        file.readAlloc(size).pipe(
                          Effect.tap((chunk) =>
                            Effect.sync(() => {
                              if (chunk._tag === "Some") fullReadBytes += chunk.value.byteLength;
                            }),
                          ),
                        ),
                    },
              ),
            );
          },
        });
        const outcomes = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const scan = yield* scanner.scan;
          expect(scan.candidates[0]?.threadCount).toBe(5);
          return yield* scanner.recentThreads(workspace).pipe(Stream.runCollect);
        }).pipe(
          Effect.provide(makeScannerTestLayer({ claudeHomePath, codexHomePath })),
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );

        expect(outcomes.map((outcome) => outcome._tag)).toEqual([
          "Importable",
          "Importable",
          "Importable",
          "Importable",
          "Skipped",
        ]);
        expect(fullReadBytes).toBe(64 * 1024 * 1024);
      }),
    );

    it.effect("skips excessive records without blocking an older valid transcript", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-record-budget-claude-");
        const codexHomePath = yield* makeTempDir("t3code-record-budget-codex-");
        const workspace = yield* makeTempDir("t3code-record-budget-workspace-");
        for (const [sessionId, padding, mtimeMs] of [
          ["excessive", "\n".repeat(100_001), nowMs],
          ["older", "", nowMs - 1_000],
        ] as const) {
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "08",
              "24",
              `rollout-${sessionId}.jsonl`,
            ),
            contents:
              [
                encodeTranscriptRecord({
                  type: "session_meta",
                  payload: { id: sessionId, cwd: workspace },
                }),
                encodeTranscriptRecord({
                  type: "event_msg",
                  payload: { type: "user_message", message: "Imported prompt" },
                }),
              ].join("\n") + padding,
            mtimeMs,
          });
        }
        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Skipped", "Importable"]);
        expect(outcomes[1]).toMatchObject({ thread: { providerSessionId: "older" } });
      }),
    );

    for (const source of ["claudeAgent", "codex"] as const) {
      for (const replacement of [
        "same root",
        "other root",
        "symlink alias",
        "other then same",
      ] as const) {
        it.effect.skipIf(replacement === "symlink alias" && !symlinksSupported)(
          `rechecks ${source} snapshot cwd after replacement with ${replacement}`,
          () =>
            Effect.gen(function* () {
              const path = yield* Path.Path;
              const fileSystem = yield* FileSystem.FileSystem;
              const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
              yield* TestClock.setTime(nowMs);
              const fixture = yield* makeTempDir("t3code-replaced-cwd-");
              const workspace = path.join(fixture, "original");
              const otherWorkspace = path.join(fixture, "other");
              const alias = path.join(fixture, "alias");
              const claudeHomePath = path.join(fixture, "claude");
              const codexHomePath = path.join(fixture, "codex");
              yield* fileSystem.makeDirectory(workspace);
              yield* fileSystem.makeDirectory(otherWorkspace);
              if (replacement === "symlink alias") yield* fileSystem.symlink(workspace, alias);
              const filePath =
                source === "codex"
                  ? path.join(
                      codexHomePath,
                      "sessions",
                      "2026",
                      "08",
                      "24",
                      "rollout-replaced.jsonl",
                    )
                  : path.join(claudeHomePath, "projects", "p", "replaced.jsonl");
              const makeContents = (cwd: string, text: string, laterCwd?: string) =>
                [
                  ...(source === "codex"
                    ? [
                        { type: "session_meta", payload: { id: "replacement-session", cwd } },
                        { type: "event_msg", payload: { type: "user_message", message: text } },
                      ]
                    : [
                        {
                          type: "user",
                          cwd,
                          sessionId: "replacement-session",
                          message: { content: text },
                        },
                      ]),
                  ...(laterCwd === undefined ? [] : [{ cwd: laterCwd }]),
                ]
                  .map((record) => encodeTranscriptRecord(record))
                  .join("\n");
              yield* writeTranscript({
                filePath,
                contents: makeContents(workspace, "Original prompt"),
                mtimeMs: nowMs,
              });

              yield* Effect.gen(function* () {
                const scanner = yield* AgentSessionScanner.AgentSessionScanner;
                const scan = yield* scanner.scan;
                expect(scan.candidates.map((candidate) => candidate.path)).toEqual([workspace]);
                const replacementCwd =
                  replacement === "symlink alias"
                    ? alias
                    : replacement === "same root"
                      ? workspace
                      : otherWorkspace;
                yield* fileSystem.remove(filePath);
                yield* writeTranscript({
                  filePath,
                  contents: makeContents(
                    replacementCwd,
                    "Replacement prompt",
                    replacement === "other then same" ? workspace : undefined,
                  ),
                  mtimeMs: nowMs,
                });
                const outcomes = yield* scanner.recentThreads(workspace).pipe(Stream.runCollect);
                if (replacement === "same root" || replacement === "symlink alias") {
                  expect(outcomes).toHaveLength(1);
                  expect(outcomes[0]).toMatchObject({
                    _tag: "Importable",
                    thread: { messages: [{ text: "Replacement prompt" }] },
                  });
                } else {
                  expect(outcomes).toEqual([{ _tag: "Skipped" }]);
                }
              }).pipe(Effect.provide(makeScannerTestLayer({ claudeHomePath, codexHomePath })));
            }),
        );
      }
    }

    it.effect("checks file identity and provider before skipping completed history", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-completed-claude-");
        const codexHomePath = yield* makeTempDir("t3code-completed-codex-");
        const workspace = yield* makeTempDir("t3code-completed-workspace-");
        const filePath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          "rollout-replaced.jsonl",
        );
        const contents = (sessionId: string) =>
          [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: sessionId, cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Imported prompt" },
            }),
          ].join("\n");
        yield* writeTranscript({
          filePath,
          contents: contents("original-session"),
          mtimeMs: nowMs,
        });

        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const initial = yield* scanner.recentThreads(workspace).pipe(Stream.runCollect);
          const imported = initial[0];
          expect(imported?._tag).toBe("Importable");
          if (imported?._tag !== "Importable") return;
          const completed = yield* scanner
            .recentThreads(workspace, [imported.source])
            .pipe(Stream.runCollect);
          expect(completed[0]?._tag).toBe("AlreadyImported");
          const wrongProvider = yield* scanner
            .recentThreads(workspace, [{ ...imported.source, provider: "claudeAgent" }])
            .pipe(Stream.runCollect);
          expect(wrongProvider[0]?._tag).toBe("Importable");

          // Keep the old inode allocated while replacing the path with an equal-size file.
          yield* fileSystem.open(filePath);
          yield* fileSystem.remove(filePath);
          yield* writeTranscript({
            filePath,
            contents: contents("replaced-session"),
            mtimeMs: nowMs,
          });
          const replaced = yield* scanner
            .recentThreads(workspace, [imported.source])
            .pipe(Stream.runCollect);
          expect(replaced[0]).toMatchObject({
            _tag: "Importable",
            thread: { providerSessionId: "replaced-session" },
            source: { size: imported.source.size, mtimeMs: imported.source.mtimeMs },
          });
        }).pipe(Effect.provide(makeScannerTestLayer({ claudeHomePath, codexHomePath })));
      }),
    );

    it.effect("reports an eligible transcript over 16 MiB as skipped", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const transcript = [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: "large-session", cwd: workspace },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message: "Import this large session" },
          }),
        ]
          .join("\n")
          .padEnd(16 * 1024 * 1024 + 1, " ");
        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-large.jsonl"),
          contents: transcript,
          mtimeMs: nowMs,
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(outcomes).toEqual([{ _tag: "Skipped" }]);
      }),
    );

    it.effect("reports stat, read, and parse failures as skipped", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const missingPath = path.join(codexHomePath, "missing.jsonl");
        const transcriptPaths = {
          stat: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-stat.jsonl"),
          read: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-read.jsonl"),
          parse: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-parse.jsonl"),
        };
        const transcriptContents = (sessionId: string) =>
          [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: sessionId, cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Import this session" },
            }),
          ].join("\n");

        yield* writeTranscript({
          filePath: transcriptPaths.stat,
          contents: transcriptContents("stat-session"),
          mtimeMs: nowMs,
        });
        yield* writeTranscript({
          filePath: transcriptPaths.read,
          contents: transcriptContents("read-session"),
          mtimeMs: nowMs,
        });
        yield* writeTranscript({
          filePath: transcriptPaths.parse,
          contents: encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: "parse-session", cwd: workspace },
          }),
          mtimeMs: nowMs,
        });

        let statCount = 0;
        let readOpenCount = 0;
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) => {
            if (filePath !== transcriptPaths.stat) return fileSystem.stat(filePath);
            statCount += 1;
            return fileSystem.stat(statCount === 1 ? filePath : missingPath);
          },
          open: (filePath, options) => {
            if (filePath !== transcriptPaths.read) return fileSystem.open(filePath, options);
            readOpenCount += 1;
            return fileSystem.open(readOpenCount === 1 ? filePath : missingPath, options);
          },
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(outcomes).toEqual([{ _tag: "Skipped" }, { _tag: "Skipped" }, { _tag: "Skipped" }]);
      }),
    );

    it.effect("does not reopen a transcript that becomes a non-file after discovery", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const nonFilePath = yield* makeTempDir("t3code-non-file-");
        const transcriptPath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          "rollout-changed.jsonl",
        );
        yield* writeTranscript({
          filePath: transcriptPath,
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "changed-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Do not import this session" },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        let transcriptStatCount = 0;
        let transcriptOpenCount = 0;
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          stat: (filePath) => {
            if (filePath !== transcriptPath) return fileSystem.stat(filePath);
            transcriptStatCount += 1;
            return fileSystem.stat(transcriptStatCount === 1 ? transcriptPath : nonFilePath);
          },
          open: (filePath, options) => {
            if (filePath === transcriptPath) transcriptOpenCount += 1;
            return fileSystem.open(filePath, options);
          },
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(transcriptStatCount).toBe(2);
        expect(transcriptOpenCount).toBe(1);
        expect(outcomes).toEqual([{ _tag: "Skipped" }]);
      }),
    );

    it.effect("does not import a transcript dated after the current time", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        yield* writeTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "08",
            "24",
            "rollout-future.jsonl",
          ),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "future-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: { type: "user_message", message: "Future work" },
            }),
          ].join("\n"),
          mtimeMs: nowMs + 1,
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(outcomes).toEqual([]);
      }),
    );

    it.effect("skips growth during reading without exceeding the reserved bytes", () =>
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
        let transcriptOpenCount = 0;
        let fullReadBytes = 0;
        let grew = false;
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) => {
            if (filePath !== transcriptPath) return fileSystem.open(filePath, options);
            transcriptOpenCount += 1;
            if (transcriptOpenCount === 1) return fileSystem.open(filePath, options);
            return fileSystem.open(filePath, options).pipe(
              Effect.map((file) => ({
                ...file,
                stat: file.stat,
                readAlloc: (size: FileSystem.SizeInput) =>
                  file.readAlloc(size).pipe(
                    Effect.tap((chunk) =>
                      Effect.gen(function* () {
                        if (chunk._tag === "None") return;
                        fullReadBytes += chunk.value.byteLength;
                        if (!grew) {
                          grew = true;
                          yield* fileSystem.writeFileString(filePath, `${contents}\nchanged`);
                        }
                      }),
                    ),
                  ),
              })),
            );
          },
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(transcriptOpenCount).toBe(2);
        expect(fullReadBytes).toBe(new TextEncoder().encode(contents).byteLength);
        expect(outcomes).toEqual([{ _tag: "Skipped" }]);
      }),
    );

    it.effect("skips a transcript that shrinks after its size check", () =>
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
          "rollout-shrinking.jsonl",
        );
        const shrunkPath = path.join(codexHomePath, "shrunk.jsonl");
        const contents = [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: "shrinking-session", cwd: workspace },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message: "Do not import a changing file" },
          }),
        ].join("\n");
        yield* writeTranscript({
          filePath: transcriptPath,
          contents: `${contents}\n${"padding".repeat(100)}`,
          mtimeMs: nowMs,
        });
        yield* writeTranscript({ filePath: shrunkPath, contents, mtimeMs: nowMs });

        let transcriptOpenCount = 0;
        const simulatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) => {
            if (filePath !== transcriptPath) return fileSystem.open(filePath, options);
            transcriptOpenCount += 1;
            return fileSystem.open(
              transcriptOpenCount === 1 ? transcriptPath : shrunkPath,
              options,
            );
          },
        });

        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        }).pipe(Effect.provideService(FileSystem.FileSystem, simulatedFileSystem));

        expect(transcriptOpenCount).toBe(2);
        expect(outcomes).toEqual([{ _tag: "Skipped" }]);
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

        expect(
          threads.flatMap((outcome) =>
            outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
          ),
        ).toEqual(["newer-session"]);
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

    it.effect("uses one deterministic provider instance for a shared session home", () =>
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
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: sharedHome },
            },
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

        expect(threads.map((thread) => thread.providerInstanceId)).toEqual(["codex"]);
      }),
    );

    it.effect("uses configured order when custom instances share a session home", () =>
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
              payload: { type: "user_message", message: "Use the first account" },
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
              config: { homePath: sharedHome },
            },
            [ProviderInstanceId.make("codex-personal")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: sharedHome },
            },
          },
        });

        expect(threads.map((thread) => thread.providerInstanceId)).toEqual(["codex-work"]);
      }),
    );

    it.effect("keeps a second account when the first has 5000 newer files", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const oldWorkspace = yield* makeTempDir("t3code-workspace-old-");
        const recentWorkspace = yield* makeTempDir("t3code-workspace-recent-");
        const recentHome = yield* makeTempDir("t3code-claude-recent-home-");
        const oldDirectory = path.join(claudeHomePath, "projects", "-aaa-old");
        const oldTranscript = path.join(oldDirectory, "old.jsonl");
        const recentDirectory = path.join(recentHome, "projects", "-zzz-recent");

        yield* writeTranscript({
          filePath: oldTranscript,
          contents: encodeTranscriptRecord({
            type: "user",
            cwd: oldWorkspace,
            sessionId: "old-session",
            message: { role: "user", content: "Old work" },
          }),
          mtimeMs: nowMs,
        });
        yield* writeTranscript({
          filePath: path.join(recentDirectory, "recent.jsonl"),
          contents: encodeTranscriptRecord({
            type: "user",
            cwd: recentWorkspace,
            sessionId: "recent-session",
            message: { role: "user", content: "Recent work" },
          }),
          mtimeMs: nowMs - 1_000,
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

        const input = {
          claudeHomePath,
          codexHomePath,
          providerInstances: {
            [ProviderInstanceId.make("claude-work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: recentHome },
            },
          },
        };
        const threads = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const scan = yield* scanner.scan;
          expect(scan.truncated).toBe(true);
          return yield* scanner.recentThreads(recentWorkspace).pipe(Stream.runCollect);
        }).pipe(
          Effect.provide(makeScannerTestLayer(input)),
          Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
        );

        expect(
          threads.flatMap((outcome) =>
            outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
          ),
        ).toEqual(["recent-session"]);
      }),
    );
  });
});

describe("parseAgentSessionTranscript", () => {
  it.each([false, true])(
    "handles the exact record limit and an interior blank overflow=%s",
    (overflow) => {
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        contents: makeRecordLimitTranscript("/project", overflow),
        source: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        fallbackSessionId: "unused",
        lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      });
      if (overflow) expect(thread).toBeNull();
      else expect(thread?.messages.map((message) => message.text)).toEqual(["First prompt"]);
    },
  );

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
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
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
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [{ type: "input_text", text: "Fix the actual bug" }],
          },
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

  it("keeps the canonical first prompt after long Codex transcripts are capped", () => {
    const canonicalPrompt = "\n  Keep the canonical prompt  \n";
    const canonicalTimestamp = "2026-08-24T10:01:00.000Z";
    const laterAssistantMessages = Array.from({ length: 200 }, (_, index) =>
      encodeTranscriptRecord({
        type: "response_item",
        timestamp: `2026-08-24T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Assistant message ${index}` }],
        },
      }),
    );
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep the canonical prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: canonicalTimestamp,
          payload: { type: "user_message", message: canonicalPrompt },
        }),
        ...laterAssistantMessages,
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]).toMatchObject({
      role: "user",
      text: canonicalPrompt,
      createdAt: canonicalTimestamp,
    });
  });

  it("restores the canonical first prompt when a later user message remains", () => {
    const canonicalPrompt = "\n  Keep the canonical prompt  \n";
    const canonicalTimestamp = "2026-08-24T10:01:00.000Z";
    const assistantMessages = Array.from({ length: 198 }, (_, index) =>
      encodeTranscriptRecord({
        type: "response_item",
        timestamp: `2026-08-24T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Assistant message ${index}` }],
        },
      }),
    );
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [{ type: "input_text", text: "Keep the canonical prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: canonicalTimestamp,
          payload: { type: "user_message", message: canonicalPrompt },
        }),
        ...assistantMessages,
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: "2026-08-24T11:58:30.000Z",
          payload: { type: "user_message", message: "Keep this later prompt" },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T11:59:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Keep this latest response" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]).toMatchObject({
      role: "user",
      text: canonicalPrompt,
      createdAt: canonicalTimestamp,
    });
    expect(
      thread?.messages.filter((message) => message.text.trim() === canonicalPrompt.trim()),
    ).toHaveLength(1);
    expect(thread?.messages.some((message) => message.text === "Keep this later prompt")).toBe(
      true,
    );
    expect(thread?.messages.at(-1)?.text).toBe("Keep this latest response");
  });

  it("keeps mixed-format response users when turn IDs repeat after an assistant", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-older" },
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
            internal_chat_message_metadata_passthrough: { turn_id: "turn-newer" },
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
            internal_chat_message_metadata_passthrough: { turn_id: "turn-newer" },
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

  it("preserves response user text when Codex turn metadata is ambiguous", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: ["unexpected"],
            content: [{ type: "input_text", text: "Keep this legacy prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "   " },
            content: [{ type: "input_text", text: "Keep this prompt with a blank turn ID" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Keep this legacy prompt",
      "Keep this prompt with a blank turn ID",
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

  it("uses the canonical Codex event when its turn has generated response context", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n<cwd>/tmp/project</cwd>\n<shell>zsh</shell>\n</environment_context>",
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nPrivate project rules\n</INSTRUCTIONS>",
              },
            ],
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
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "Do something here so it looks like a real project.",
              },
            ],
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

  it("preserves context markup in response-only Codex messages", () => {
    const context = "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>";
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
                text: context,
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

    expect(thread?.title).toBe("<environment_context>");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      context,
      "Initialize Git and add a README.",
    ]);
  });

  it("preserves a canonical Codex event that starts with context markup", () => {
    const prompt =
      "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\n\nCreate a useful project.";
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: prompt,
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("<environment_context>");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
  });

  it("preserves a Codex request heading in a canonical event", () => {
    const prompt = "\n  ## My request for Codex:\n\nFix the visible bug";
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: prompt,
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("## My request for Codex:");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
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
