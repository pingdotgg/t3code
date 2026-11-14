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
  describe("recentThreads", () => {
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
