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

export const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const layerProjectStore = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed(
        importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
      ),
  });

export interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir?: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
  readonly configBaseDir?: string;
  readonly providerInstances?: ContractServerSettings["providerInstances"];
}

export const layerScannerTest = (input: ScannerTestInput) =>
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

export const runScan = (input: ScannerTestInput) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan;
  }).pipe(Effect.provide(layerScannerTest(input)));

export const runRecentThreadOutcomes = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.recentThreads(input.workspaceRoot).pipe(
      Stream.runCollect,
      Effect.map((outcomes) => Array.from(outcomes)),
    );
  }).pipe(Effect.provide(layerScannerTest(input)));

export const runRecentThreads = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  runRecentThreadOutcomes(input).pipe(
    Effect.map((outcomes) =>
      outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : [])),
    ),
  );

export const makeTempDir = Effect.fn("AgentSessionScanner.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

export const writeTranscript = Effect.fn("AgentSessionScanner.test.writeTranscript")(function* (input: {
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

export const claudeSessionLine = (cwd: string) =>
  `${JSON.stringify({ type: "user", cwd, sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`;

export const codexRolloutLine = (cwd: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd } })}\n`;

export const decodeImportSource = Schema.decodeUnknownSync(AgentSessionImportSource);

export const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function makeRecordLimitTranscript(cwd: string, overflow: boolean): string {
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

export const makeFileIdentityFixture = Effect.fn("AgentSessionScanner.test.makeFileIdentityFixture")(
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

export const LIBUV_POOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE ?? 4);

/**
 * Opening a FIFO for reading waits in `open()` until a writer appears, like a
 * TCC-protected file in a headless macOS daemon, and pins one libuv pool thread
 * that fiber interruption cannot free. The finalizer opens it for writing on the
 * main thread, which releases every waiting reader even with the pool exhausted.
 */
export const makeOpenGate = Effect.fn("AgentSessionScanner.test.makeOpenGate")(function* (
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
