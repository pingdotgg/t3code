// @effect-diagnostics nodeBuiltinImport:off - FIFO gates must be released with a synchronous
// open on the main thread, because the Effect FileSystem queues behind the pinned libuv pool.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - type for instrumented native file handles.
import type * as NodeFSP from "node:fs/promises";
import { describe, expect, it, vi, type Mock } from "@effect/vitest";
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
import * as AgentSessionHistory from "./AgentSessionHistory.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerProjectStore = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed(
        importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
      ),
  });

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir?: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
  readonly configBaseDir?: string;
  readonly providerInstances?: ContractServerSettings["providerInstances"];
}

const layerScannerTest = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: input.claudeHomePath },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: input.codexHomePath },
            },
            // Keeps the default Pi instance off the developer's real ~/.pi.
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              environment: [
                {
                  name: "PI_CODING_AGENT_DIR",
                  value: input.piAgentDir ?? `${input.claudeHomePath}/pi-agent`,
                  sensitive: false,
                },
                { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
              ],
              config: {},
            },
            ...input.providerInstances,
          },
        }),
        ServerConfig.layerTest(
          input.claudeHomePath,
          input.configBaseDir ?? { prefix: "t3code-scanner-config-" },
        ),
        layerProjectStore(input.importedWorkspaceRoots ?? []),
      ),
    ),
  );

const runScan = (input: ScannerTestInput) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan;
  }).pipe(Effect.provide(layerScannerTest(input)));

const runRecentThreadOutcomes = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.recentThreads(input.workspaceRoot).pipe(
      Stream.runCollect,
      Effect.map((outcomes) => Array.from(outcomes)),
    );
  }).pipe(Effect.provide(layerScannerTest(input)));

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
  readonly mtimeMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* fileSystem.writeFileString(input.filePath, input.contents);
  const seconds = input.mtimeMs / 1000;
  yield* fileSystem.utimes(input.filePath, seconds, seconds);
});

const claudeSessionLine = (cwd: string) =>
  `${JSON.stringify({ type: "user", cwd, sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`;

const codexRolloutLine = (cwd: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd } })}\n`;

const decodeImportSource = Schema.decodeUnknownSync(AgentSessionImportSource);

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

const makeFileIdentityFixture = Effect.fn("AgentSessionScanner.test.makeFileIdentityFixture")(
  function* (originalInode = 10_000_000_000_000_001n, replacementInode = 10_000_000_000_000_000n) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
    yield* TestClock.setTime(nowMs);
    const claudeHomePath = yield* makeTempDir("t3code-large-id-claude-");
    const codexHomePath = yield* makeTempDir("t3code-large-id-codex-");
    const workspace = yield* makeTempDir("t3code-large-id-workspace-");
    const filePath = path.join(
      codexHomePath,
      "sessions",
      "2026",
      "08",
      "24",
      "rollout-identity.jsonl",
    );
    const replacementPath = `${filePath}.replacement`;
    const savedPath = `${filePath}.saved`;
    for (const [target, sessionId] of [
      [filePath, "original-session"],
      [replacementPath, "replaced-session"],
    ] as const) {
      yield* writeTranscript({
        filePath: target,
        contents: [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: sessionId, cwd: workspace },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            payload: { type: "user_message", message: "Imported prompt" },
          }),
        ].join("\n"),
        mtimeMs: nowMs,
      });
    }

    // Adjacent NTFS IDs round to the same number; birthtimes can also collide.
    const birthtime = Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(nowMs)));
    const ids = new Map<bigint, bigint>();
    const effectIdentity = (target: string, info: FileSystem.File.Info) => {
      if (target !== filePath) return info;
      const realInode = Option.getOrThrow(info.ino);
      const inode = ids.get(realInode) ?? (ids.size === 0 ? originalInode : replacementInode);
      ids.set(realInode, inode);
      return { ...info, ino: Option.some(inode), birthtime };
    };
    let opens = 0;
    const simulatedFileSystem = FileSystem.FileSystem.of({
      ...fileSystem,
      stat: (target) =>
        fileSystem.stat(target).pipe(Effect.map((info) => effectIdentity(target, info))),
      open: (target, options) => {
        if (target === filePath) opens += 1;
        return fileSystem.open(target, options).pipe(
          Effect.map((file) => ({
            ...file,
            stat: file.stat.pipe(Effect.map((info) => effectIdentity(target, info))),
            readAlloc: (size: number) => file.readAlloc(size),
          })),
        );
      },
    });
    const scanner = yield* AgentSessionScanner.AgentSessionScanner.pipe(
      Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })),
      Effect.provideService(FileSystem.FileSystem, simulatedFileSystem),
    );
    return {
      scanner,
      workspace,
      opens: () => opens,
      replace: Effect.gen(function* () {
        yield* fileSystem.rename(filePath, savedPath);
        yield* fileSystem.rename(replacementPath, filePath);
      }).pipe(Effect.orDie),
    };
  },
);

const LIBUV_POOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE ?? 4);

/**
 * Opening a FIFO for reading waits in `open()` until a writer appears, like a
 * TCC-protected file in a headless macOS daemon, and pins one libuv pool thread
 * that fiber interruption cannot free. The finalizer opens it for writing on the
 * main thread, which releases every waiting reader even with the pool exhausted.
 */
const makeOpenGate = Effect.fn("AgentSessionScanner.test.makeOpenGate")(function* (
  gatePath: string,
) {
  NodeChildProcess.execFileSync("mkfifo", [gatePath]);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      try {
        NodeFS.closeSync(
          NodeFS.openSync(gatePath, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK),
        );
      } catch {
        // ENXIO: no reader is waiting.
      }
    }),
  );
});

/**
 * Resolves once a reader has opened the FIFO, so its read deadline is already
 * scheduled on the TestClock. The writer stays open until the scope closes, so
 * the reader sees no EOF and has to wait out that deadline.
 */
const awaitGateReader = (gatePath: string) =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFS.promises.open(gatePath, NodeFS.constants.O_WRONLY)),
    (handle) => Effect.promise(() => handle.close()),
  );

it.layer(NodeServices.layer)("AgentSessionScanner", (it) => {
  describe("scan", () => {
    it.effect("reads Claude project cwds from transcripts, newest first", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const olderWorkspace = yield* makeTempDir("t3code-workspace-older-");
        const newerWorkspace = yield* makeTempDir("t3code-workspace-newer-");

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
            git: null,
          },
          {
            path: olderWorkspace,
            title: path.basename(olderWorkspace),
            sources: ["claudeAgent"],
            threadCount: 2,
            lastActiveAt: "2026-01-02T00:00:00.000Z",
            alreadyImported: false,
            git: null,
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
            git: null,
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
          git: null,
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
            git: null,
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

    it.effect("uses explicit default-slot homes instead of the fixture homes", () =>
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
        const piAgentDir = yield* makeTempDir("t3code-pi-agent-");
        const piSessionDir = yield* makeTempDir("t3code-pi-sessions-");
        const claudeWorkspace = yield* makeTempDir("t3code-workspace-claude-");
        const codexWorkspace = yield* makeTempDir("t3code-workspace-codex-");
        const piWorkspace = yield* makeTempDir("t3code-workspace-pi-");
        const piFlatWorkspace = yield* makeTempDir("t3code-workspace-pi-flat-");

        // Pi nests sessions per cwd by default and keeps a custom session directory flat.
        for (const [filePath, cwd, mtime] of [
          [
            path.join(piAgentDir, "sessions", "--slug--", "2026-01-03_pi.jsonl"),
            piWorkspace,
            "2026-01-03T00:00:00.000Z",
          ],
          [
            path.join(piSessionDir, "2026-01-04_pi-flat.jsonl"),
            piFlatWorkspace,
            "2026-01-04T00:00:00.000Z",
          ],
        ] as const) {
          yield* writeTranscript({
            filePath,
            contents: `${encodeTranscriptRecord({ type: "session", version: 3, id: "pi", cwd })}\n`,
            mtimeMs: Date.parse(mtime),
          });
        }
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
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              environment: [
                { name: "PI_CODING_AGENT_DIR", value: piAgentDir, sensitive: false },
                { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
              ],
              config: {},
            },
            [ProviderInstanceId.make("pi-flat")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              environment: [
                { name: "PI_CODING_AGENT_SESSION_DIR", value: piSessionDir, sensitive: false },
              ],
              config: {},
            },
          },
        });

        expect(result.candidates.map((candidate) => [candidate.path, candidate.sources])).toEqual([
          [piFlatWorkspace, ["pi"]],
          [piWorkspace, ["pi"]],
          [codexWorkspace, ["codex"]],
          [claudeWorkspace, ["claudeAgent"]],
        ]);
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

  describe("recentThreads", () => {
    it.effect.each(["claudeAgent", "codex"] as const)(
      "previews recent %s messages after a large tool output",
      (provider) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const claudeHomePath = yield* makeTempDir("t3-history-claude-");
          const codexHomePath = yield* makeTempDir("t3-history-codex-");
          const workspace = yield* makeTempDir("t3-history-workspace-");
          yield* TestClock.setTime(Date.parse("2026-08-24T12:00:00.000Z"));
          const sessionId = "6a0418c0-60d4-4516-ab72-81ba35fd579b";
          const header =
            provider === "codex"
              ? { type: "session_meta", payload: { session_id: sessionId, cwd: workspace } }
              : {
                  type: "user",
                  sessionId,
                  cwd: workspace,
                  message: { content: "Investigate reconnect" },
                };
          const handoff = `Context handoff (manual_context):\nProvider context handoff. ${"coverage ".repeat(600)}\n\nUser message:\nVerify reconnect after sleep.`;
          const request =
            provider === "codex"
              ? { type: "event_msg", payload: { type: "user_message", message: handoff } }
              : { type: "user", sessionId, message: { content: handoff } };
          const latest =
            provider === "codex"
              ? {
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "The retry fix still needs verification." },
                    ],
                  },
                }
              : {
                  type: "assistant",
                  sessionId,
                  message: { content: "The retry fix still needs verification." },
                };
          const filePath =
            provider === "codex"
              ? path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-session.jsonl")
              : path.join(claudeHomePath, "projects", "project", `${sessionId}.jsonl`);
          yield* writeTranscript({
            filePath,
            contents:
              [
                header,
                ...Array.from({ length: 6 }, (_, index) =>
                  provider === "codex"
                    ? {
                        type: "event_msg",
                        payload: { type: "user_message", message: `Earlier ${index}` },
                      }
                    : { type: "user", sessionId, message: { content: `Earlier ${index}` } },
                ),
                { type: "tool", output: "猫".repeat(680_000) },
              ]
                .map((record) => encodeTranscriptRecord(record))
                .join("\r\n") + "\r\n",
            mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
          });
          const fs = yield* FileSystem.FileSystem;
          let bytesRead = 0;
          const measuredFs = FileSystem.FileSystem.of({
            ...fs,
            open: (target, options) =>
              fs.open(target, options).pipe(
                Effect.map((file) => ({
                  ...file,
                  stat: file.stat,
                  seek: (offset, from) => file.seek(offset, from),
                  readAlloc: (size: number) =>
                    file.readAlloc(size).pipe(
                      Effect.tap((chunk) =>
                        Effect.sync(() => {
                          if (target === filePath && Option.isSome(chunk))
                            bytesRead += chunk.value.byteLength;
                        }),
                      ),
                    ),
                })),
              ),
          });
          yield* fs.writeFile(
            filePath,
            Buffer.concat([
              Buffer.from('{"type":"tool","output":"'),
              Buffer.from([0xff]),
              Buffer.from(
                '"}\r\n' +
                  [request, latest].map((record) => encodeTranscriptRecord(record)).join("\r\n"),
              ),
            ]),
            { flag: "a" },
          );
          const modifiedAt = Date.parse("2026-08-24T11:00:00.000Z") / 1000;
          yield* fs.utimes(filePath, modifiedAt, modifiedAt);
          yield* Effect.gen(function* () {
            const scanner = yield* AgentSessionScanner.AgentSessionScanner;
            const full = yield* scanner.previewSession({
              workspaceRoot: workspace,
              session: {
                providerInstanceId: ProviderInstanceId.make(provider),
                providerSessionId: sessionId,
              },
            });
            expect(full.status).toBe("ready");
            if (full.status !== "ready") return;
            expect(full.boundedWindow).toBe(false);
            yield* fs.writeFileString(
              filePath,
              "\r\n" + encodeTranscriptRecord({ type: "tool", output: "x".repeat(100_000) }),
              { flag: "a" },
            );
            yield* fs.utimes(filePath, modifiedAt, modifiedAt);
            const preview = yield* scanner.previewSession({
              workspaceRoot: workspace,
              session: {
                providerInstanceId: ProviderInstanceId.make(provider),
                providerSessionId: sessionId,
              },
            });
            expect(preview.status).toBe("ready");
            if (preview.status !== "ready") return;
            expect(preview.messages.map((message) => message.text)).toEqual([
              "Verify reconnect after sleep.",
              "The retry fix still needs verification.",
            ]);
            expect(preview.messages[0]?.truncated).toBe(false);
            expect(preview.messages.map((message) => message.id)).toEqual(
              full.messages.slice(-2).map((message) => message.id),
            );
            const imported = yield* scanner
              .recentThreads(workspace, [], {
                providerInstanceId: ProviderInstanceId.make(provider),
                providerSessionId: sessionId,
              })
              .pipe(Stream.runCollect);
            expect(imported[0]?._tag).toBe("Importable");
            if (imported[0]?._tag === "Importable") {
              expect(imported[0].thread.messages.some((message) => message.text === handoff)).toBe(
                true,
              );
            }
            expect(preview.boundedWindow).toBe(true);
            yield* fs.writeFileString(
              filePath,
              "\n" +
                [{ type: "tool", output: "x".repeat(2 * 1024 * 1024 - 101_000) }, latest]
                  .map((record) => encodeTranscriptRecord(record))
                  .join("\n") +
                "\n",
              { flag: "a" },
            );
            yield* fs.utimes(filePath, modifiedAt, modifiedAt);
            const shifted = yield* scanner.previewSession({
              workspaceRoot: workspace,
              session: {
                providerInstanceId: ProviderInstanceId.make(provider),
                providerSessionId: sessionId,
              },
            });
            expect(shifted.status).toBe("ready");
            if (shifted.status !== "ready") return;
            expect(shifted.messages.map((message) => message.text)).toEqual([
              "The retry fix still needs verification.",
              "The retry fix still needs verification.",
            ]);
            expect(shifted.messages[0]?.id).toBe(preview.messages[1]?.id);
            expect(shifted.messages[1]?.id).not.toBe(shifted.messages[0]?.id);
            yield* fs.writeFileString(
              filePath,
              [{ type: "tool", output: "x".repeat(5 * 1024 * 1024) }, latest]
                .map((record) => encodeTranscriptRecord(record))
                .join("\n") + "\n",
              { flag: "a" },
            );
            yield* fs.utimes(filePath, modifiedAt, modifiedAt);
            const input = {
              workspaceRoot: workspace,
              session: {
                providerInstanceId: ProviderInstanceId.make(provider),
                providerSessionId: sessionId,
              },
            };
            const newest = yield* scanner.previewSession(input);
            expect(newest.status).toBe("ready");
            if (newest.status !== "ready") return;
            expect(
              yield* scanner.previewSession({ ...input, cursor: shifted.nextCursor! }),
            ).toEqual({ status: "unavailable", reason: "changed" });
            for (const cursor of [
              { revision: newest.revision, before: 0, byteOffset: Number.MAX_SAFE_INTEGER },
              { revision: newest.revision, before: 0, byteOffset: 0 },
              { revision: newest.revision, before: 0 },
              { revision: newest.revision, before: 100_000 },
            ]) {
              expect(yield* scanner.previewSession({ ...input, cursor })).toEqual({
                status: "unavailable",
                reason: "unreadable",
              });
            }
            const history = [...newest.messages];
            let cursor = newest.nextCursor;
            let pages = 0;
            while (cursor !== null && pages < 10) {
              bytesRead = 0;
              const older = yield* scanner.previewSession({
                workspaceRoot: workspace,
                session: {
                  providerInstanceId: ProviderInstanceId.make(provider),
                  providerSessionId: sessionId,
                },
                cursor,
              });
              expect(older.status).toBe("ready");
              if (older.status !== "ready") return;
              expect(bytesRead).toBeLessThanOrEqual(3 * 1024 * 1024);
              expect(older.messages.length).toBeLessThanOrEqual(4);
              history.unshift(...older.messages);
              cursor = older.nextCursor;
              pages += 1;
            }
            expect(cursor).toBeNull();
            expect(pages).toBeGreaterThan(2);
            expect(history.map((message) => message.text)).toEqual([
              ...(provider === "claudeAgent" ? ["Investigate reconnect"] : []),
              ...Array.from({ length: 6 }, (_, index) => `Earlier ${index}`),
              "Verify reconnect after sleep.",
              "The retry fix still needs verification.",
              "The retry fix still needs verification.",
              "The retry fix still needs verification.",
            ]);
            expect(new Set(history.map((message) => message.id)).size).toBe(history.length);
          }).pipe(
            Effect.provide(
              layerScannerTest({ claudeHomePath, codexHomePath }).pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, measuredFs)),
              ),
            ),
          );
        }),
    );
    it.effect.each(["long-message", "dense-records"] as const)(
      "reaches complete history across %s budgets",
      (scenario) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const claudeHomePath = yield* makeTempDir("t3-review-claude-");
          const codexHomePath = yield* makeTempDir("t3-review-codex-");
          const workspace = yield* makeTempDir("t3-review-workspace-");
          yield* TestClock.setTime(Date.parse("2026-08-24T12:00:00.000Z"));
          const sessionId = "review-session";
          const expectedText =
            scenario === "long-message" ? "猫😀".repeat(2000) : "Original prompt";
          const records = [
            { type: "metadata", sessionId, cwd: workspace },
            { type: "user", sessionId, message: { content: expectedText } },
            ...(scenario === "dense-records" ? Array.from({ length: 100_001 }, () => ({})) : []),
            { type: "assistant", sessionId, message: { content: "Active answer" } },
          ];
          const filePath = path.join(claudeHomePath, "projects", "project", `${sessionId}.jsonl`);
          yield* writeTranscript({
            filePath,
            contents:
              "\n" + records.map((record) => encodeTranscriptRecord(record)).join("\n") + "\n",
            mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
          });
          yield* Effect.gen(function* () {
            const scanner = yield* AgentSessionScanner.AgentSessionScanner;
            const input = {
              workspaceRoot: workspace,
              session: {
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                providerSessionId: sessionId,
              },
            };
            const messages: Array<{ id: string; text: string; role: string }> = [];
            let cursor: import("@t3tools/contracts").AgentSessionPreviewInput["cursor"];
            for (let page = 0; page < 5; page++) {
              const result = yield* scanner.previewSession({
                ...input,
                ...(cursor === undefined ? {} : { cursor }),
              });
              expect(result.status).toBe("ready");
              if (result.status !== "ready") return;
              expect(result.messages.length).toBeLessThanOrEqual(4);
              for (const message of result.messages) {
                expect(message.text.length).toBeLessThanOrEqual(4000);
                expect(message.text.isWellFormed()).toBe(true);
              }
              messages.unshift(...result.messages);
              if (result.nextCursor === null) {
                cursor = undefined;
                break;
              }
              cursor = result.nextCursor;
            }
            expect(cursor).toBeUndefined();
            expect(
              messages
                .filter((message) => message.role === "user")
                .map((message) => message.text)
                .join(""),
            ).toBe(expectedText);
            expect(
              messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.text),
            ).toEqual(["Active answer"]);
            expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
            const initial = yield* scanner.previewSession(input);
            if (initial.status !== "ready") throw new Error("Expected readable history");
            for (const textBefore of [0, expectedText.length + 1, 2]) {
              if (scenario !== "long-message") continue;
              expect(
                yield* scanner.previewSession({
                  ...input,
                  cursor: { revision: initial.revision, before: 1, textBefore },
                }),
              ).toEqual({ status: "unavailable", reason: "unreadable" });
            }
          }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })));
        }),
    );
    it.effect.each([
      "metadata-prefix",
      "metadata-records",
      "codex-metadata",
      "pi-metadata",
      "aggregate-selection",
      "aggregate-records",
      "aggregate-bytes",
      "aggregate-operations",
    ] as const)("discovers and previews sessions beyond %s on demand", (scenario) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3-discovery-claude-");
        const codexHomePath = yield* makeTempDir("t3-discovery-codex-");
        const workspace = yield* makeTempDir("t3-discovery-workspace-");
        const now = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(now);
        const text =
          scenario === "metadata-prefix" ? "x".repeat(2 * 1024 * 1024 + 100) : "Original prompt";
        const provider =
          scenario === "codex-metadata"
            ? "codex"
            : scenario === "pi-metadata"
              ? "pi"
              : "claudeAgent";
        if (scenario === "metadata-prefix") {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", "workspace", "known.jsonl"),
            contents:
              encodeTranscriptRecord({
                type: "user",
                cwd: workspace,
                sessionId: "known",
                message: { content: "Already discovered" },
              }) + "\n",
            mtimeMs: now,
          });
        }
        yield* writeTranscript({
          filePath:
            provider === "codex"
              ? path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-target.jsonl")
              : provider === "pi"
                ? path.join(claudeHomePath, "pi-agent", "sessions", "workspace", "target.jsonl")
                : path.join(claudeHomePath, "projects", "workspace", "target.jsonl"),
          contents:
            (scenario === "metadata-records" || scenario.endsWith("-metadata")
              ? "{}\n".repeat(1001)
              : scenario === "aggregate-records"
                ? "{}\n".repeat(100001)
                : "") +
            (provider === "codex"
              ? [
                  { type: "session_meta", payload: { id: "target", cwd: workspace } },
                  { type: "event_msg", payload: { type: "user_message", message: text } },
                ]
              : provider === "pi"
                ? [
                    { type: "session", id: "target", cwd: workspace },
                    {
                      type: "message",
                      id: "message-1",
                      parentId: null,
                      message: { role: "user", content: text },
                    },
                  ]
                : [
                    {
                      type: "user",
                      cwd: workspace,
                      sessionId: "target",
                      message: { content: text },
                    },
                  ]
            )
              .map(encodeTranscriptRecord)
              .join("\n") +
            "\n",
          mtimeMs: now - 10_000,
        });
        if (["aggregate-selection", "aggregate-bytes", "aggregate-operations"].includes(scenario)) {
          const count =
            scenario === "aggregate-operations"
              ? 20001
              : scenario === "aggregate-bytes"
                ? 65
                : 5001;
          for (let index = 0; index < count; index++) {
            yield* writeTranscript({
              filePath: path.join(
                claudeHomePath,
                "projects",
                "workspace",
                `neighbor-${index}.jsonl`,
              ),
              contents:
                scenario === "aggregate-operations"
                  ? ""
                  : encodeTranscriptRecord({
                      padding:
                        scenario === "aggregate-bytes" ? "x".repeat(1024 * 1024 - 500) : undefined,
                      type: "user",
                      cwd: workspace,
                      sessionId: `neighbor-${index}`,
                    }),
              mtimeMs: now - 1000,
            });
          }
        }
        const fs = yield* FileSystem.FileSystem;
        const indexes: Array<string> = [];
        const measuredFs = FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectory: (options) =>
            fs.makeTempDirectory(options).pipe(
              Effect.tap((directory) =>
                Effect.sync(() => {
                  if (options?.prefix === "t3-history-discovery-") indexes.push(directory);
                }),
              ),
            ),
        });
        const files: Array<NodeFSP.FileHandle> = [];
        const reads: Array<Mock<NodeFSP.FileHandle["read"]>> = [];
        const originalOpen = NodeFS.promises.open;
        using _open = vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
          const file = await originalOpen(...args);
          files.push(file);
          const read = vi.fn(file.read.bind(file));
          file.read = read;
          reads.push(read);
          return file;
        });
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          let page = yield* scanner.listSessions({
            workspaceRoot: workspace,
            query: scenario === "aggregate-selection" ? "Original prompt" : undefined,
            limit: 50,
          });
          const firstCursor = page.nextCursor;
          if (scenario === "metadata-prefix") {
            expect(page.truncated).toBe(true);
            expect(page.sessions.map((session) => session.providerSessionId)).toEqual(["known"]);
          }
          let firstPage: typeof page | undefined;
          let found = page.sessions.find((session) => session.providerSessionId === "target");
          for (let step = 0; page.nextCursor !== null && step < 1000; step++) {
            const input = {
              workspaceRoot: workspace,
              query: scenario === "aggregate-selection" ? "Original prompt" : undefined,
              limit: 50,
              cursor: page.nextCursor,
            };
            for (const read of reads) read.mockClear();
            page = yield* scanner.listSessions(input);
            if (scenario === "metadata-prefix" && page.truncated) {
              expect(page.sessions.map((session) => session.providerSessionId)).toEqual(["known"]);
            }
            firstPage ??= page;
            expect(
              reads.reduce(
                (total, read) =>
                  total +
                  read.mock.calls.reduce((sum, [options]) => sum + (options?.length ?? 0), 0),
                0,
              ),
            ).toBeLessThanOrEqual(1024 * 1024);
            expect(yield* scanner.listSessions(input)).toEqual(page);
            found ??= page.sessions.find((session) => session.providerSessionId === "target");
          }
          expect(found?.providerSessionId).toBe("target");
          expect(page.nextCursor).toBeNull();
          expect(firstPage).toBeDefined();
          if (firstCursor && firstPage) {
            const input = {
              workspaceRoot: workspace,
              query: scenario === "aggregate-selection" ? "Original prompt" : undefined,
              limit: 50,
              cursor: firstCursor,
            };
            expect(yield* scanner.listSessions(input)).toEqual(firstPage);
            if (scenario === "metadata-prefix") {
              expect(firstPage.truncated).toBe(true);
              yield* writeTranscript({
                filePath: path.join(claudeHomePath, "projects", "workspace", "known.jsonl"),
                contents:
                  encodeTranscriptRecord({
                    type: "user",
                    cwd: workspace,
                    sessionId: "known",
                    message: { content: "Changed after discovery began" },
                  }) + "\n",
                mtimeMs: now + 1000,
              });
              yield* TestClock.adjust("31 seconds");
              expect(yield* scanner.listSessions(input)).toEqual(firstPage);
            }
            expect(
              (yield* scanner
                .listSessions({
                  ...input,
                  cursor: { ...firstCursor, discovery: `${firstCursor.discovery}:invalid` },
                })
                .pipe(Effect.flip)).operation,
            ).toBe("discovery-cursor");
          }
          const input = {
            workspaceRoot: workspace,
            session: {
              providerInstanceId: ProviderInstanceId.make(provider),
              providerSessionId: "target",
            },
          };
          let preview = yield* scanner.previewSession(input);
          let reconstructed = "";
          for (let step = 0; step < 1000; step++) {
            expect(preview.status).toBe("ready");
            if (preview.status !== "ready") break;
            reconstructed =
              preview.messages.map((message) => message.text).join("") + reconstructed;
            if (preview.nextCursor === null) break;
            preview = yield* scanner.previewSession({ ...input, cursor: preview.nextCursor });
          }
          expect(reconstructed).toBe(text);
          expect(
            yield* scanner.previewSession({
              ...input,
              workspaceRoot: path.join(workspace, "other"),
            }),
          ).toEqual({ status: "unavailable", reason: "unreadable" });
        }).pipe(
          Effect.provide(
            layerScannerTest({ claudeHomePath, codexHomePath }).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, measuredFs)),
            ),
          ),
        );
        expect(files.every((file) => file.fd === -1)).toBe(true);
        expect(indexes).toHaveLength(1);
        for (const directory of indexes) expect(yield* fs.exists(directory)).toBe(false);
      }),
    );
    it.effect.each([
      "oversized-record",
      "oversized-whitespace",
      "pi-branch",
      "pi-dense",
      "codex-boundary",
      "codex-dense",
      "codex-before",
      "codex-repeated",
      "codex-context",
      "codex-empty-assistant",
    ] as const)("reaches complete history across %s budgets", (scenario) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3-review-claude-");
        const codexHomePath = yield* makeTempDir("t3-review-codex-");
        const piAgentDir = yield* makeTempDir("t3-review-pi-");
        const workspace = yield* makeTempDir("t3-review-workspace-");
        yield* TestClock.setTime(Date.parse("2026-08-24T12:00:00.000Z"));
        const provider = scenario.startsWith("pi-")
          ? "pi"
          : scenario.startsWith("codex")
            ? "codex"
            : "claudeAgent";
        const sessionId = "review-session";
        const expectedText =
          scenario === "oversized-record"
            ? '猫😀\n"\\'.repeat(220_000)
            : provider === "codex"
              ? "  Original prompt  "
              : "Original prompt";
        const records: Array<unknown> =
          provider === "pi"
            ? [
                { type: "session", id: sessionId, cwd: workspace },
                {
                  type: "message",
                  id: "root",
                  parentId: null,
                  message: { role: "user", content: expectedText },
                },
                {
                  type: "message",
                  id: "abandoned",
                  parentId: "root",
                  message: { role: "assistant", content: "Abandoned answer" },
                },
                {
                  type: "message",
                  id: "tool",
                  parentId: "root",
                  message: {
                    role: "toolResult",
                    content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }],
                  },
                },
                {
                  type: "message",
                  id: "null",
                  parentId: "tool",
                  message: { role: "toolResult", content: null },
                },
                {
                  type: "message",
                  id: "leaf",
                  parentId: "null",
                  message: { role: "assistant", content: "Active answer" },
                },
              ]
            : provider === "codex"
              ? [
                  { type: "session_meta", payload: { id: sessionId, cwd: workspace } },
                  { type: "event_msg", payload: { type: "user_message", message: expectedText } },
                  { type: "tool", output: "x".repeat(3 * 1024 * 1024) },
                  {
                    type: "response_item",
                    payload: {
                      type: "message",
                      role: "user",
                      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
                      content: [{ type: "input_text", text: expectedText.trim() }],
                    },
                  },
                  {
                    type: "response_item",
                    payload: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Active answer" }],
                    },
                  },
                ]
              : [
                  { type: "metadata", sessionId, cwd: workspace },
                  {
                    type: "user",
                    sessionId,
                    message: {
                      content:
                        scenario === "oversized-whitespace"
                          ? " ".repeat(33 * 1024 * 1024) + expectedText
                          : expectedText,
                    },
                  },
                  { type: "assistant", sessionId, message: { content: "Active answer" } },
                ];
        if (scenario === "pi-dense")
          records.splice(3, 1, ...Array.from({ length: 100_001 }, () => ({})), {
            type: "message",
            id: "tool",
            parentId: "root",
            message: { role: "toolResult", content: null },
          });
        if (scenario === "codex-dense")
          records.splice(2, 1, ...Array.from({ length: 100_001 }, () => ({})));
        if (scenario === "codex-repeated") {
          const canonical = records.splice(1, 1)[0]!;
          records.splice(2, 1);
          const response = {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: expectedText.trim() }],
            },
          };
          records.splice(1, 0, response, response);
          records.splice(records.length - 1, 0, canonical);
        }
        if (scenario === "codex-before") {
          const canonical = records.splice(1, 1)[0]!;
          records.splice(records.length - 1, 0, canonical);
        }
        if (scenario === "codex-empty-assistant")
          records.splice(
            1,
            0,
            {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
                content: [{ type: "input_text", text: "Earlier context" }],
              },
            },
            { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
          );
        if (scenario === "codex-context")
          records.splice(1, 0, {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
              content: [
                {
                  type: "input_text",
                  text: "<environment_context>Injected context</environment_context>",
                },
              ],
            },
          });
        const filePath =
          provider === "pi"
            ? path.join(piAgentDir, "sessions", "project", "session.jsonl")
            : provider === "codex"
              ? path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-session.jsonl")
              : path.join(claudeHomePath, "projects", "project", `${sessionId}.jsonl`);
        yield* writeTranscript({
          filePath,
          contents: records.map((record) => encodeTranscriptRecord(record)).join("\n") + "\n",
          mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
        });
        const otherSessionId = "other-session";
        if (scenario === "pi-branch") {
          yield* writeTranscript({
            filePath: path.join(piAgentDir, "sessions", "project", "other.jsonl"),
            contents:
              records
                .map((record, index) =>
                  encodeTranscriptRecord(
                    index === 0 ? { type: "session", id: otherSessionId, cwd: workspace } : record,
                  ),
                )
                .join("\n") + "\n",
            mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
          });
        }
        const fs = yield* FileSystem.FileSystem;
        let bytesRead = 0;
        const indexes: Array<string> = [];
        const measuredFs = FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectory: (options) =>
            fs.makeTempDirectory(options).pipe(
              Effect.tap((directory) =>
                Effect.sync(() => {
                  if (options?.prefix === "t3-history-preview-") indexes.push(directory);
                }),
              ),
            ),
          open: (target, options) =>
            fs.open(target, options).pipe(
              Effect.map((file) => ({
                ...file,
                stat: file.stat,
                seek: (offset, from) => file.seek(offset, from),
                readAlloc: (size: number) =>
                  file.readAlloc(size).pipe(
                    Effect.tap((chunk) =>
                      Effect.sync(() => {
                        if (target === filePath && Option.isSome(chunk))
                          bytesRead += chunk.value.length;
                      }),
                    ),
                  ),
              })),
            ),
        });
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const input = {
            workspaceRoot: workspace,
            session: {
              providerInstanceId: ProviderInstanceId.make(provider),
              providerSessionId: sessionId,
            },
          };
          const messages: Array<{ id: string; text: string; role: string }> = [];
          let recentPreview: import("@t3tools/contracts").AgentSessionPreviewResult | undefined;
          let cursor: import("@t3tools/contracts").AgentSessionPreviewInput["cursor"];
          let replay:
            | {
                cursor: NonNullable<typeof cursor>;
                result: import("@t3tools/contracts").AgentSessionPreviewResult;
              }
            | undefined;
          let finished = false;
          for (let page = 0; page < 1000; page++) {
            bytesRead = 0;
            const result = yield* scanner.previewSession({
              ...input,
              ...(cursor === undefined ? {} : { cursor }),
            });
            expect(result.status).toBe("ready");
            if (result.status !== "ready") return;
            expect(bytesRead).toBeLessThanOrEqual((page === 0 ? 4 : 3) * 1024 * 1024);
            expect(result.messages.length).toBeLessThanOrEqual(4);
            for (const message of result.messages) {
              expect(message.text.length).toBeLessThanOrEqual(4000);
              expect(message.text.isWellFormed()).toBe(true);
            }
            if (cursor?.scan && !replay) replay = { cursor, result };
            if (result.messages.length > 0) recentPreview ??= result;
            messages.unshift(...result.messages);
            if (result.nextCursor === null) {
              finished = true;
              break;
            }
            cursor = result.nextCursor;
          }
          expect(finished).toBe(true);
          expect(recentPreview).toBeDefined();
          expect(yield* scanner.previewSession(input)).toEqual(recentPreview);
          expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
          if (replay) {
            expect(yield* scanner.previewSession({ ...input, cursor: replay.cursor })).toEqual(
              replay.result,
            );
            for (const invalid of [
              { ...replay.cursor, before: 1_000_000 },
              { ...replay.cursor, byteOffset: 1 },
              { ...replay.cursor, textBefore: 1 },
              { ...replay.cursor, scan: "unknown" },
            ])
              expect(yield* scanner.previewSession({ ...input, cursor: invalid })).toEqual({
                status: "unavailable",
                reason: "unreadable",
              });
          }
          expect(
            messages
              .filter((message) => message.role === "user")
              .map((message) => message.text)
              .join(""),
          ).toBe(
            scenario === "codex-repeated"
              ? expectedText.trim() + expectedText
              : scenario === "codex-empty-assistant"
                ? "Earlier context" + expectedText
                : expectedText,
          );
          expect(
            messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
          ).toEqual(["Active answer"]);
          if (replay) {
            expect(
              yield* scanner.previewSession({
                ...input,
                cursor: { ...replay.cursor, revision: "changed" },
              }),
            ).toEqual({ status: "unavailable", reason: "changed" });
            if (scenario === "pi-branch") {
              const otherInput = {
                ...input,
                session: { ...input.session, providerSessionId: otherSessionId },
              };
              const otherStart = yield* scanner.previewSession(otherInput);
              expect(otherStart.status).toBe("ready");
              if (otherStart.status !== "ready" || !otherStart.nextCursor) return;
              const otherPage = yield* scanner.previewSession({
                ...otherInput,
                cursor: otherStart.nextCursor,
              });
              const repeatedStarts = [];
              for (let index = 0; index < 6; index++) {
                repeatedStarts.push(yield* scanner.previewSession(otherInput));
                expect(yield* scanner.previewSession({ ...input, cursor: replay.cursor })).toEqual(
                  replay.result,
                );
              }
              expect(
                yield* scanner.previewSession({ ...otherInput, cursor: otherStart.nextCursor }),
              ).toEqual(otherPage);
              if (otherPage.status === "ready" && otherPage.nextCursor)
                expect(
                  (yield* scanner.previewSession({ ...otherInput, cursor: otherPage.nextCursor }))
                    .status,
                ).toBe("ready");
              for (const start of repeatedStarts) expect(start).toEqual(otherStart);
              expect(indexes).toHaveLength(2);
              for (let index = 1; index <= 8; index++) {
                yield* scanner.previewSession({
                  ...otherInput,
                  cursor: {
                    revision: otherStart.revision,
                    before: 0,
                    byteOffset: index,
                  },
                });
                if (index <= 4)
                  expect(
                    yield* scanner.previewSession({ ...input, cursor: replay.cursor }),
                  ).toEqual(replay.result);
              }
              expect(yield* scanner.previewSession({ ...input, cursor: replay.cursor })).toEqual({
                status: "unavailable",
                reason: "unreadable",
              });
              expect(yield* fs.exists(indexes[0]!)).toBe(false);
            } else {
              yield* fs.writeFileString(filePath, "\n", { flag: "a" });
              expect(yield* scanner.previewSession({ ...input, cursor: replay.cursor })).toEqual({
                status: "unavailable",
                reason: "changed",
              });
            }
          }
        }).pipe(
          Effect.provide(
            layerScannerTest({ claudeHomePath, codexHomePath, piAgentDir }).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, measuredFs)),
            ),
          ),
        );
        for (const directory of indexes) expect(yield* fs.exists(directory)).toBe(false);
      }),
    );
    it.effect("selects an older session without importing neighboring sessions", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        yield* TestClock.setTime(Date.parse("2026-08-24T12:00:00.000Z"));
        for (const sessionId of ["older-session", "neighbor"]) {
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "01",
              "01",
              `rollout-${sessionId}.jsonl`,
            ),
            contents: [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: sessionId, cwd: workspace },
              }),
              encodeTranscriptRecord({
                type: "event_msg",
                payload: { type: "user_message", message: `Investigate ${sessionId}` },
              }),
              ...Array.from({ length: sessionId === "older-session" ? 30 : 0 }, (_, index) =>
                encodeTranscriptRecord({
                  type: "event_msg",
                  payload: { type: "user_message", message: `Follow-up ${index}` },
                }),
              ),
            ].join("\n"),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          });
        }
        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const outcomes = yield* scanner
            .recentThreads(workspace, [], {
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "older-session",
            })
            .pipe(Stream.runCollect);
          expect(
            outcomes.map((outcome) =>
              outcome._tag === "Importable" ? outcome.thread.providerSessionId : outcome._tag,
            ),
          ).toEqual(["older-session"]);
          const previewInput = {
            workspaceRoot: workspace,
            session: {
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "older-session",
            },
          };
          const history = yield* AgentSessionHistory.AgentSessionHistory;
          const preview = yield* history.generateRecap(previewInput);
          expect(
            (yield* history.listSessions({ workspaceRoot: workspace, query: "violet" })).sessions,
          ).toMatchObject([
            {
              providerSessionId: "older-session",
              recentExcerpt: "Follow-up 29",
              recap: { summary: "The release marker is violet." },
            },
          ]);
          expect(preview.status).toBe("ready");
          if (preview.status !== "ready") throw new Error("Expected readable history");
          expect(preview.messages.map((message) => message.text)).toEqual([
            "Follow-up 26",
            "Follow-up 27",
            "Follow-up 28",
            "Follow-up 29",
          ]);
          expect(preview.nextCursor).not.toBeNull();
          if (preview.nextCursor === null) throw new Error("Expected older history");
          const older = yield* scanner.previewSession({
            ...previewInput,
            cursor: preview.nextCursor,
          });
          expect(older.status).toBe("ready");
          if (older.status !== "ready") throw new Error("Expected readable older history");
          expect(older.messages.map((message) => message.text)).toEqual([
            "Follow-up 22",
            "Follow-up 23",
            "Follow-up 24",
            "Follow-up 25",
          ]);
          expect(
            new Set([...preview.messages, ...older.messages].map((message) => message.id)).size,
          ).toBe(8);
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "01",
              "01",
              "rollout-older-session.jsonl",
            ),
            contents: [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: "older-session", cwd: workspace },
              }),
              encodeTranscriptRecord({
                type: "event_msg",
                payload: { type: "user_message", message: "Updated conversation" },
              }),
            ].join("\n"),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          });
          expect(
            (yield* history.listSessions({ workspaceRoot: workspace, query: "violet" })).sessions,
          ).toEqual([]);
          const updatedList = yield* history.listSessions({ workspaceRoot: workspace });
          const updatedSession = updatedList.sessions.find(
            (session) => session.providerSessionId === "older-session",
          );
          expect(updatedSession?.recap).toBeUndefined();
          expect(updatedSession?.recentExcerpt).toBeUndefined();
          expect(
            yield* scanner.previewSession({ ...previewInput, cursor: preview.nextCursor }),
          ).toEqual({ status: "unavailable", reason: "changed" });
          expect(
            yield* scanner.previewSession({
              ...previewInput,
              session: { ...previewInput.session, providerSessionId: "../../outside" },
            }),
          ).toEqual({ status: "unavailable", reason: "unreadable" });
          yield* TestClock.adjust("31 seconds");
          const first = yield* scanner.listSessions({ workspaceRoot: workspace, limit: 1 });
          expect(first.sessions.map((session) => session.providerSessionId)).toEqual(["neighbor"]);
          expect(first.nextCursor).not.toBeNull();
          expect(
            (yield* scanner.listSessions({
              workspaceRoot: workspace,
              query: "Updated conversation",
              limit: 1,
            })).sessions.map((session) => session.providerSessionId),
          ).toEqual(["older-session"]);
          expect(
            (yield* scanner.listSessions({ workspaceRoot: workspace })).sessions.map(
              (session) => session.title,
            ),
          ).toEqual(["Investigate neighbor", "Updated conversation"]);
          yield* writeTranscript({
            filePath: path.join(codexHomePath, "sessions", "2026", "01", "01", "rollout-new.jsonl"),
            contents: encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "new", cwd: workspace },
            }),
            mtimeMs: Date.parse("2026-08-24T11:00:00.000Z"),
          });
          const second = yield* scanner.listSessions({
            workspaceRoot: workspace,
            limit: 1,
            cursor: first.nextCursor!,
          });
          expect(second.sessions.map((session) => session.providerSessionId)).toEqual([
            "older-session",
          ]);
          expect(second.nextCursor).toBeNull();
          const other = yield* scanner.listSessions({
            workspaceRoot: path.join(workspace, "other"),
          });
          expect(other.sessions).toEqual([]);
          expect((yield* scanner.listSessions({ workspaceRoot: workspace })).sessions).toHaveLength(
            2,
          );
          yield* TestClock.adjust("31 seconds");
          expect(
            (yield* scanner.listSessions({ workspaceRoot: workspace })).sessions.map(
              (session) => session.providerSessionId,
            ),
          ).toEqual(["new", "neighbor", "older-session"]);
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "01",
              "01",
              "rollout-older-session.jsonl",
            ),
            contents: [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: "replacement", cwd: workspace },
              }),
              encodeTranscriptRecord({
                type: "event_msg",
                payload: { type: "user_message", message: "Different session" },
              }),
            ].join("\n"),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          });
          expect(yield* scanner.previewSession(previewInput)).toEqual({
            status: "unavailable",
            reason: "unreadable",
          });
        }).pipe(
          Effect.provide(
            AgentSessionHistory.layer.pipe(
              Layer.provideMerge(
                layerScannerTest({ claudeHomePath, codexHomePath, configBaseDir: workspace }),
              ),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                Layer.mock(TextGeneration.TextGeneration)({
                  generateSessionRecap: () =>
                    Effect.succeed({ summary: "The release marker is violet.", nextAction: null }),
                }),
              ),
            ),
          ),
        );
      }),
    );

    it.effect("imports recent Claude, Codex, and Pi sessions for the selected project only", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const piAgentDir = yield* makeTempDir("t3code-pi-agent-");
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
        const piMessage = (
          id: string,
          parentId: string | null,
          message: { readonly role: string; readonly content: unknown },
        ) =>
          encodeTranscriptRecord({
            type: "message",
            id,
            parentId,
            timestamp: "2026-08-24T11:00:00.000Z",
            message,
          });
        // The user rewound to the first prompt; the abandoned branch stays in the file.
        yield* writeTranscript({
          filePath: path.join(piAgentDir, "sessions", "--selected--", "2026-08-24_pi.jsonl"),
          contents: [
            encodeTranscriptRecord({
              type: "session",
              version: 3,
              id: "pi-recent",
              cwd: workspace,
            }),
            piMessage("a1", null, { role: "user", content: "Plan the change" }),
            piMessage("a2", "a1", {
              role: "assistant",
              content: [{ type: "text", text: "Abandoned answer" }],
            }),
            piMessage("a3", "a2", { role: "user", content: "Abandoned follow-up" }),
            piMessage("b1", "a1", {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Hidden reasoning" },
                { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
              ],
            }),
            piMessage("bn", "b1", { role: "toolResult", content: null }),
            piMessage("b2", "bn", {
              role: "toolResult",
              content: [{ type: "text", text: "Tool output" }],
            }),
            piMessage("b3", "b2", {
              role: "assistant",
              content: [{ type: "text", text: "Active answer" }],
            }),
            encodeTranscriptRecord({
              type: "session_info",
              id: "b4",
              parentId: "b3",
              name: "Pi refactor",
            }),
          ].join("\n"),
          mtimeMs: nowMs - 30 * 60 * 1000,
        });
        // Version 1 sessions predate the entry tree.
        yield* writeTranscript({
          filePath: path.join(piAgentDir, "sessions", "--selected--", "2025-01-01_pi-v1.jsonl"),
          contents: [
            encodeTranscriptRecord({ type: "session", id: "pi-v1", cwd: workspace }),
            encodeTranscriptRecord({
              type: "message",
              message: { role: "user", content: "Legacy prompt" },
            }),
            encodeTranscriptRecord({
              type: "message",
              message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }] },
            }),
          ].join("\n"),
          mtimeMs: nowMs - 2 * 24 * 60 * 60 * 1000,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          piAgentDir,
          workspaceRoot: workspace,
        });

        expect(threads.map((thread) => thread.providerSessionId)).toEqual([
          "pi-recent",
          "codex-recent",
          "claude-recent",
          "pi-v1",
        ]);
        expect(threads.map((thread) => thread.messages.map((message) => message.text))).toEqual([
          ["Plan the change", "Active answer"],
          ["Review this code", "Looks good"],
          ["Fix the project", "Done"],
          ["Legacy prompt", "Legacy answer"],
        ]);
        expect(threads[0]).toMatchObject({ source: "pi", title: "Pi refactor" });
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

    it.effect("titles Codex sessions with their newest saved Codex name", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");

        yield* writeTranscript({
          filePath: path.join(codexHomePath, "sessions", "2026", "08", "24", "rollout-named.jsonl"),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "named-session", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              payload: {
                type: "user_message",
                message:
                  '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\nHey, what\'s up?',
              },
            }),
          ].join("\n"),
          mtimeMs: nowMs,
        });
        yield* fileSystem.writeFileString(
          path.join(codexHomePath, "session_index.jsonl"),
          [
            { id: "named-session", thread_name: "First name" },
            { id: "other-session", thread_name: "Other chat" },
            { id: "named-session", thread_name: "Renamed chat" },
            { id: "named-session", thread_name: " " },
          ]
            .map((entry) => `${encodeTranscriptRecord({ ...entry, updated_at: "unknown" })}\n`)
            .join(""),
        );

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(threads.map((thread) => thread.title)).toEqual(["Renamed chat"]);
      }),
    );

    it.effect("excludes Codex subagents from discovery and the recent-thread budget", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const workspace = yield* makeTempDir("t3code-workspace-");
        const subagentSources = [
          { subagent: { thread_spawn: { parent_thread_id: "session-100", depth: 1 } } },
          { subagent: "review" },
          { subagent: { other: "guardian" } },
          { subAgent: "compact" },
        ];
        // Newer subagents would exhaust the 100-transcript import budget before any parent.
        const sources = [
          ...Array.from({ length: 100 }, (_, index) => subagentSources[index % 4]),
          "vscode",
          undefined,
          null,
          { custom: "launcher" },
        ];
        for (const [index, source] of sources.entries()) {
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
              { type: "session_meta", payload: { id: `session-${index}`, cwd: workspace, source } },
              // A later cwd must not make an excluded rollout eligible again.
              { type: "turn_context", payload: { cwd: workspace } },
              {
                type: "event_msg",
                payload: { type: "user_message", message: "Import this prompt" },
              },
            ]
              .map((record) => encodeTranscriptRecord(record))
              .join("\n"),
            mtimeMs: nowMs - index * 60_000,
          });
        }

        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const scan = yield* scanner.scan;
          expect.soft(scan.candidates.map((candidate) => candidate.threadCount)).toEqual([4]);
          const outcomes = yield* Stream.runCollect(scanner.recentThreads(workspace));
          expect(
            outcomes.map((outcome) =>
              outcome._tag === "Importable" ? outcome.thread.providerSessionId : outcome._tag,
            ),
          ).toEqual(["session-100", "session-101", "session-102", "session-103"]);
        }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })));
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

    it.effect("skips excessive records without blocking an older valid transcript", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-record-budget-claude-");
        const codexHomePath = yield* makeTempDir("t3code-record-budget-codex-");
        const workspace = yield* makeTempDir("t3code-record-budget-workspace-");
        const exactLimit = makeRecordLimitTranscript(workspace, false);
        // The newer transcript has 100,001 records; the older one has exactly 100,000.
        for (const [sessionId, contents, mtimeMs] of [
          ["excessive", exactLimit.replace("record-limit-session", "excessive") + "{}\n", nowMs],
          ["older", exactLimit, nowMs - 1_000],
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
            contents,
            mtimeMs,
          });
        }
        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Skipped", "Importable"]);
        expect(outcomes[1]).toMatchObject({
          thread: { providerSessionId: "record-limit-session" },
        });
      }),
    );

    it.effect("imports every transcript that fits the per-file record limit", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-shared-records-claude-");
        const codexHomePath = yield* makeTempDir("t3code-shared-records-codex-");
        const workspace = yield* makeTempDir("t3code-shared-records-workspace-");
        // Together these exceed 100,000 records, but each one is individually valid.
        const recordCounts = [20_000, 20_000, 20_000, 58_000];
        for (const [index, recordCount] of recordCounts.entries()) {
          yield* writeTranscript({
            filePath: path.join(
              codexHomePath,
              "sessions",
              "2026",
              "08",
              "24",
              `rollout-${index}.jsonl`,
            ),
            contents:
              [
                encodeTranscriptRecord({
                  type: "session_meta",
                  payload: { id: `session-${index}`, cwd: workspace },
                }),
                encodeTranscriptRecord({
                  type: "event_msg",
                  payload: { type: "user_message", message: "Imported prompt" },
                }),
              ].join("\n") +
              "\n" +
              "{}\n".repeat(recordCount - 2),
            mtimeMs: nowMs - index * 1_000,
          });
        }
        const outcomes = yield* runRecentThreadOutcomes({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });
        expect(
          outcomes.map((outcome) =>
            outcome._tag === "Importable" ? outcome.thread.providerSessionId : outcome._tag,
          ),
        ).toEqual(["session-0", "session-1", "session-2", "session-3"]);
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
              }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath })));
            }),
        );
      }
    }

    it.effect("checks file identity and provider before skipping completed history", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFileIdentityFixture(42n, 43n);
        const { scanner, workspace } = fixture;
        const initial = yield* scanner.recentThreads(workspace).pipe(Stream.runCollect);
        const imported = initial[0];
        expect(imported?._tag).toBe("Importable");
        if (imported?._tag !== "Importable") return;
        const legacy = decodeImportSource({ ...imported.source, inode: 42 });
        const opensBeforeCompleted = fixture.opens();
        const completed = yield* scanner.recentThreads(workspace, [legacy]).pipe(Stream.runCollect);
        expect(completed[0]?._tag).toBe("AlreadyImported");
        expect(fixture.opens()).toBe(opensBeforeCompleted);
        const wrongProvider = yield* scanner
          .recentThreads(workspace, [{ ...imported.source, provider: "claudeAgent" }])
          .pipe(Stream.runCollect);
        expect(wrongProvider[0]?._tag).toBe("Importable");

        yield* fixture.replace;
        const replaced = yield* scanner
          .recentThreads(workspace, [imported.source])
          .pipe(Stream.runCollect);
        expect(replaced[0]).toMatchObject({
          _tag: "Importable",
          thread: { providerSessionId: "replaced-session" },
          source: { size: imported.source.size, mtimeMs: imported.source.mtimeMs },
        });
      }),
    );

    it.effect(
      "imports same-metadata replacements with exact large file IDs and backfills legacy IDs once",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFileIdentityFixture();
          const { scanner, workspace } = fixture;
          const initial = yield* scanner.recentThreads(workspace).pipe(Stream.runCollect);
          const imported = initial[0];
          expect(imported?._tag).toBe("Importable");
          if (imported?._tag !== "Importable") return;

          yield* fixture.replace;
          const replaced = yield* scanner
            .recentThreads(workspace, [imported.source])
            .pipe(Stream.runCollect);
          expect(replaced[0]).toMatchObject({
            _tag: "Importable",
            thread: { providerSessionId: "replaced-session" },
            source: {
              ...imported.source,
              providerSessionId: "replaced-session",
              inode: "10000000000000000",
            },
          });
          expect(imported.source.inode).toBe("10000000000000001");
          if (replaced[0]?._tag !== "Importable") return;

          const roundedInode = Number(imported.source.inode);
          expect(Number.isSafeInteger(roundedInode)).toBe(false);
          expect(String(roundedInode)).toBe(replaced[0].source.inode);
          for (const inode of [null, roundedInode]) {
            const legacy = decodeImportSource({ ...imported.source, inode });
            const opensBeforeBackfill = fixture.opens();
            const backfilled = yield* scanner
              .recentThreads(workspace, [legacy])
              .pipe(Stream.runCollect);
            expect(backfilled[0]).toMatchObject({
              _tag: "Importable",
              thread: { providerSessionId: "replaced-session" },
              source: replaced[0].source,
            });
            expect(fixture.opens()).toBe(opensBeforeBackfill + 1);
            if (backfilled[0]?._tag !== "Importable") return;
            const completed = yield* scanner
              .recentThreads(workspace, [backfilled[0].source])
              .pipe(Stream.runCollect);
            expect(completed[0]?._tag).toBe("AlreadyImported");
            expect(fixture.opens()).toBe(opensBeforeBackfill + 1);
          }
        }),
    );

    it.effect("imports long Claude tool history with metadata from discarded records", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("t3code-long-claude-");
        const codexHomePath = yield* makeTempDir("t3code-long-codex-");
        const workspace = yield* makeTempDir("t3code-long-workspace-");
        const record = (fields: Record<string, unknown>) =>
          encodeTranscriptRecord({ sessionId: "first-session", ...fields });
        const toolResult = record({
          type: "user",
          cwd: path.join(workspace, "later-cwd"),
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
          },
        });
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-slug", "long-session.jsonl"),
          contents: [
            record({ type: "attachment", cwd: workspace, aiTitle: "Old title" }),
            record({ type: "user", message: { role: "user", content: "First prompt" } }),
            record({
              type: "assistant",
              message: { role: "assistant", model: "claude-opus-5-5", content: "First reply" },
            }),
            // Small tool records exceed the real 32 MiB selected-history budget in aggregate.
            ...Array.from({ length: 20_000 }, () => toolResult),
            record({ type: "user", message: { role: "user", content: "Latest prompt" } }),
            record({
              type: "assistant",
              message: {
                role: "assistant",
                model: "claude-sonnet-5-5",
                content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
              },
            }),
            record({ type: "custom-title", customTitle: "Renamed conversation" }),
            record({ type: "ai-title", aiTitle: "Newest title" }),
            record({ type: "attachment", sessionId: "latest-session" }),
          ].join("\n"),
          mtimeMs: nowMs,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(threads).toMatchObject([
          {
            providerSessionId: "latest-session",
            title: "Renamed conversation",
            model: "claude-sonnet-5-5",
            messages: [
              { role: "user", text: "First prompt" },
              { role: "assistant", text: "First reply" },
              { role: "user", text: "Latest prompt" },
            ],
          },
        ]);
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
                readAlloc: (size: number) =>
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
  });
});

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

  it.each([199, 200, 201, 205])(
    "counts only omitted conversation messages for a %s-message Claude transcript",
    (count) => {
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        contents: [
          ...Array.from({ length: count }, (_, index) =>
            encodeTranscriptRecord({
              type: index === 0 ? "user" : "assistant",
              sessionId: "claude-session",
              message: { content: `Message ${index}` },
            }),
          ),
          encodeTranscriptRecord({ type: "user", isMeta: true, message: { content: "Setup" } }),
          encodeTranscriptRecord({
            type: "user",
            isCompactSummary: true,
            message: { content: "Summary" },
          }),
          encodeTranscriptRecord({
            type: "assistant",
            isSidechain: true,
            message: { content: "Sidechain" },
          }),
          encodeTranscriptRecord({
            type: "assistant",
            message: { content: [{ type: "tool_use" }] },
          }),
          "malformed",
        ].join("\n"),
        source: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        fallbackSessionId: "fallback",
        lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      });

      expect(thread?.omittedMessageCount).toBe(Math.max(0, count - 200));
      expect(thread?.messages).toHaveLength(Math.min(200, count));
      expect(thread?.messages[0]?.text).toBe("Message 0");
      expect(thread?.messages.at(-1)?.text).toBe(`Message ${count - 1}`);
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

  it.each([
    { customTitles: ["Refactor auth module"], expected: "Refactor auth module" },
    // Claude writes an empty customTitle when the user clears a rename.
    { customTitles: ["Refactor auth module", ""], expected: "Generated title" },
  ])("uses Claude custom titles $customTitles over the AI title", ({ customTitles, expected }) => {
    const aiTitle = JSON.stringify({
      type: "ai-title",
      aiTitle: "Generated title",
      sessionId: "claude-session",
    });
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          timestamp: "2026-08-24T10:00:00.000Z",
          message: { role: "user", content: "<command-name>/effort</command-name>" },
        }),
        // Claude rewrites both records on every metadata flush with ai-title
        // last, so a later ai-title must not override the user's rename.
        ...customTitles.flatMap((customTitle) => [
          JSON.stringify({ type: "custom-title", customTitle, sessionId: "claude-session" }),
          aiTitle,
        ]),
      ].join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.title).toBe(expected);
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

  it.each([199, 200])("keeps the canonical first prompt with %s later Codex messages", (count) => {
    const canonicalPrompt = "\n  Keep the canonical prompt  \n";
    const canonicalTimestamp = "2026-08-24T10:01:00.000Z";
    const laterAssistantMessages = Array.from({ length: count }, (_, index) =>
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

    expect(thread?.omittedMessageCount).toBe(count - 199);
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

    expect(thread?.omittedMessageCount).toBe(1);
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

    expect(thread?.title).toBe("Initialize Git and add a README.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      context,
      "Initialize Git and add a README.",
    ]);
  });

  it("titles a Codex event after the request that follows injected setup blocks", () => {
    const prompt = [
      "<recommended_plugins>\nGitHub\n</recommended_plugins>",
      "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>",
      '<in-app-browser-context source="ambient-ui-state">\nTab\n</in-app-browser-context>',
      "Fix the import titles",
    ].join("\n");
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: prompt },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Fix the import titles");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
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
});
