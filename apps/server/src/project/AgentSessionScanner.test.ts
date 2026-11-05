import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
