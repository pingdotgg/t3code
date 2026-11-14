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

  });
});
