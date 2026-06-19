// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { AntigravitySettings, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  makeAntigravityAdapter,
  mapAntigravityTranscriptRecordToRuntimeEvents,
  parseAntigravityTranscriptLine,
} from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const makeTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: baseDir,
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfigShape;
  });

function diagnosticEventType(event: unknown): string {
  return event !== null && typeof event === "object" && "type" in event
    ? String((event as { readonly type?: unknown }).type)
    : JSON.stringify(event);
}

async function waitFor(
  predicate: () => boolean,
  events: ReadonlyArray<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting; events=${events.map(diagnosticEventType).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("AntigravityAdapter transcript helpers", () => {
  it("parses valid transcript lines and ignores malformed lines", () => {
    expect(
      parseAntigravityTranscriptLine(
        '{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE"}',
      ),
    ).toMatchObject({
      step_index: 7,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
    });

    expect(parseAntigravityTranscriptLine("not json")).toBeUndefined();
    expect(parseAntigravityTranscriptLine("   ")).toBeUndefined();
  });

  it("maps command transcript records to command lifecycle and output events", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      instanceId: ProviderInstanceId.make("antigravity"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-05-29T00:00:00.000Z",
      record: {
        step_index: 10,
        source: "MODEL",
        type: "RUN_COMMAND",
        status: "DONE",
        content: "47.0",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["item.completed", "content.delta"]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
    });
    expect(events[1]?.payload).toMatchObject({
      streamKind: "command_output",
      delta: "47.0",
    });
  });

  it("maps tool call records to dynamic tool lifecycle events", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "write_to_file",
            args: { TargetFile: '"/tmp/add_numbers.py"' },
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("item.completed");
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Write file",
    });
  });

  it("normalizes Antigravity list tool call titles", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            name: "List_dir",
            args: { path: "/tmp/project" },
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Listed directory",
      detail: "/tmp/project",
    });
  });

  it("does not render echoed user prompts or conversation history", () => {
    for (const record of [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>say hi</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "SYSTEM",
        type: "CONVERSATION_HISTORY",
        status: "DONE",
        content: "# Conversation History",
      },
    ]) {
      expect(
        mapAntigravityTranscriptRecordToRuntimeEvents({
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          record,
        }),
      ).toEqual([]);
    }
  });

  it("maps directory listings to tool items without assistant text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 3,
        source: "MODEL",
        type: "LIST_DIRECTORY",
        status: "DONE",
        content: '{"name":"package.json"}',
      },
    });

    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      status: "completed",
      title: "Listed directory",
    });
  });

  it("emits assistant text and completes final response records", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 12,
        source: "MODEL",
        type: "FINAL_RESPONSE",
        status: "DONE",
        content: "Done.",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Done.",
    });
  });

  it("strips Antigravity protocol and tool-log noise from final response text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 12,
        source: "MODEL",
        type: "FINAL_RESPONSE",
        status: "DONE",
        content: [
          "Created At: 2026-06-01T10:21:47Z Completed At: 2026-06-01T10:21:47Z",
          "You have read and write access to the following workspace(s):",
          "/home/coder",
          "command(cat): allowed",
          "Browser initialized successfully with anti-detection features",
          "Done.",
        ].join("\n"),
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Done.",
    });
  });

  it("maps system error transcript records to runtime failures", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 4,
        source: "SYSTEM",
        type: "ERROR_MESSAGE",
        status: "DONE",
        error: "usage limit has been exhausted",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      message: "usage limit has been exhausted",
      class: "provider_error",
    });
    expect(events[1]?.payload).toMatchObject({
      state: "failed",
      errorMessage: "usage limit has been exhausted",
    });
  });

  it("treats terminal planner responses as assistant text", () => {
    const events = mapAntigravityTranscriptRecordToRuntimeEvents({
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      record: {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Adapter launch probe only.",
      },
    });

    expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(events[0]?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Adapter launch probe only.",
    });
  });
});

describe("AntigravityAdapter resumed-output turn reopen", () => {
  it("does not duplicate list-dir planner and concrete transcript records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "antig-list-dedupe-"));
    try {
      const brainPath = join(baseDir, "brain");
      const conversationId = "conv-list-dedupe";
      const transcriptPath = join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, "");

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: join(baseDir, "settings.json"),
      });

      const config = await Effect.runPromise(
        makeTestServerConfig(baseDir).pipe(Effect.provide(NodeServices.layer)),
      );
      const adapter = await Effect.runPromise(
        makeAntigravityAdapter(settings, {
          instanceId: ProviderInstanceId.make("antigravity"),
          environment: {},
        }).pipe(Effect.provideService(ServerConfig, config), Effect.provide(NodeServices.layer)),
      );

      const events: ProviderRuntimeEvent[] = [];
      const collector = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );
      const threadId = ThreadId.make("thread-list-dedupe");
      try {
        await Effect.runPromise(
          adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            cwd: baseDir,
            resumeCursor: { conversationId },
          }),
        );

        await appendFile(
          transcriptPath,
          [
            JSON.stringify({
              step_index: 3,
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              tool_calls: [{ name: "List_dir", args: { path: baseDir } }],
            }),
            JSON.stringify({
              step_index: 3,
              source: "MODEL",
              type: "LIST_DIRECTORY",
              status: "DONE",
              content: '{"name":"package.json"}',
            }),
            "",
          ].join("\n"),
        );

        await waitFor(
          () => events.filter((event) => event.type === "item.completed").length === 1,
          events,
        );
        await new Promise((resolve) => setTimeout(resolve, 700));

        const toolEvents = events.filter((event) => event.type === "item.completed");
        expect(toolEvents).toHaveLength(1);
        expect(toolEvents[0]?.payload).toMatchObject({
          itemType: "dynamic_tool_call",
          title: "Listed directory",
        });
      } finally {
        await Effect.runPromise(adapter.stopSession(threadId)).catch(() => undefined);
        await Effect.runPromise(Fiber.interrupt(collector)).catch(() => undefined);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("reopens a turn when transcript output resumes after a completed turn", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "antig-reopen-"));
    try {
      const brainPath = join(baseDir, "brain");
      const conversationId = "conv-resume";
      const transcriptPath = join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, "");

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: join(baseDir, "settings.json"),
      });

      const config = await Effect.runPromise(
        makeTestServerConfig(baseDir).pipe(Effect.provide(NodeServices.layer)),
      );
      const adapter = await Effect.runPromise(
        makeAntigravityAdapter(settings, {
          instanceId: ProviderInstanceId.make("antigravity"),
          environment: {},
        }).pipe(Effect.provideService(ServerConfig, config), Effect.provide(NodeServices.layer)),
      );

      const events: ProviderRuntimeEvent[] = [];
      const collector = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );
      const threadId = ThreadId.make("thread-resume");
      try {
        await Effect.runPromise(
          adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            cwd: baseDir,
            resumeCursor: { conversationId },
          }),
        );

        // A terminal response completes the turn (the "stop phase").
        await appendFile(
          transcriptPath,
          `${JSON.stringify({ step_index: 1, source: "MODEL", type: "FINAL_RESPONSE", status: "DONE", content: "Started in background." })}\n`,
        );
        await waitFor(() => events.some((event) => event.type === "turn.completed"), events);

        // Output that resumes afterwards must reopen the turn.
        await appendFile(
          transcriptPath,
          `${JSON.stringify({ step_index: 2, source: "MODEL", type: "RUN_COMMAND", status: "DONE", content: "HELLO_AFTER_WAIT" })}\n`,
        );
        await waitFor(
          () => events.filter((event) => event.type === "turn.started").length >= 2,
          events,
        );

        const turnStarts = events.filter((event) => event.type === "turn.started");
        expect(turnStarts.length).toBeGreaterThanOrEqual(2);
        expect(turnStarts[1]?.turnId).toBeDefined();
        expect(turnStarts[1]?.turnId).not.toBe(turnStarts[0]?.turnId);

        const firstCompletedIdx = events.findIndex((event) => event.type === "turn.completed");
        const reopenIdx = events.findIndex(
          (event, index) => index > firstCompletedIdx && event.type === "turn.started",
        );
        const commandIdx = events.findIndex(
          (event) =>
            event.type === "item.completed" &&
            (event.payload as { itemType?: string }).itemType === "command_execution",
        );
        expect(reopenIdx).toBeGreaterThan(firstCompletedIdx);
        expect(commandIdx).toBeGreaterThan(reopenIdx);
        // Resumed output is attributed to the reopened turn.
        expect(events[reopenIdx]?.turnId).toBeDefined();
        expect(events[commandIdx]?.turnId).toBe(events[reopenIdx]?.turnId);
      } finally {
        await Effect.runPromise(adapter.stopSession(threadId)).catch(() => undefined);
        await Effect.runPromise(Fiber.interrupt(collector)).catch(() => undefined);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

interface FakeDaemon {
  readonly address: string;
  readonly interactions: Array<unknown>;
  close(): Promise<void>;
}

const readFakeDaemonRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => resolve(body));
  });

async function startFakeAntigravityDaemon(): Promise<FakeDaemon> {
  const interactions: Array<unknown> = [];
  const state = { approveWaiting: true };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const body = await readFakeDaemonRequestBody(req);
      if (url.endsWith("/GetCascadeTrajectory")) {
        const trajectory = state.approveWaiting
          ? {
              trajectory: {
                trajectoryId: "traj-1",
                steps: [
                  {
                    status: "CORTEX_STEP_STATUS_WAITING",
                    metadata: {
                      sourceTrajectoryStepInfo: { trajectoryId: "traj-1", stepIndex: 0 },
                    },
                    requestedInteraction: {
                      permission: { resource: { action: "RUN_COMMAND", target: "ls -la" } },
                    },
                  },
                ],
              },
            }
          : { trajectory: { trajectoryId: "traj-1", steps: [] } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(trajectory));
        return;
      }
      if (url.endsWith("/HandleCascadeUserInteraction")) {
        interactions.push(JSON.parse(body) as unknown);
        // Once approved, the daemon clears the WAITING step.
        state.approveWaiting = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    address: `http://127.0.0.1:${port}`,
    interactions,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("AntigravityAdapter full-access auto-approval", () => {
  it("auto-approves permission gates without approval runtime events", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "antig-autoapprove-"));
    const daemon = await startFakeAntigravityDaemon();
    try {
      const brainPath = join(baseDir, "brain");
      const conversationId = "conv-autoapprove";
      const transcriptPath = join(
        brainPath,
        conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, "");

      const settings = decodeAntigravitySettings({
        brainPath,
        settingsPath: join(baseDir, "settings.json"),
        languageServerAddress: daemon.address,
      });

      const config = await Effect.runPromise(
        makeTestServerConfig(baseDir).pipe(Effect.provide(NodeServices.layer)),
      );
      const adapter = await Effect.runPromise(
        makeAntigravityAdapter(settings, {
          instanceId: ProviderInstanceId.make("antigravity"),
          // Short-circuit daemon detection so the fake server is used directly.
          environment: { ANTIGRAVITY_LS_ADDRESS: daemon.address },
          // Avoid spawning the real agentapi binary; the resume path ignores stdout.
          runAgentApi: () => Promise.resolve(""),
        }).pipe(Effect.provideService(ServerConfig, config), Effect.provide(NodeServices.layer)),
      );

      const events: ProviderRuntimeEvent[] = [];
      const collector = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );
      const threadId = ThreadId.make("thread-autoapprove");
      try {
        await Effect.runPromise(
          adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            cwd: baseDir,
            resumeCursor: { conversationId },
          }),
        );

        // An active turn is required before the gate poller inspects the trajectory.
        await Effect.runPromise(adapter.sendTurn({ threadId, input: "run the command" }));

        await waitFor(() => daemon.interactions.length === 1, daemon.interactions);

        expect(events.map((event) => event.type)).not.toContain("request.opened");
        expect(events.map((event) => event.type)).not.toContain("request.resolved");

        // The daemon received exactly one allow decision for the gate.
        expect(daemon.interactions).toHaveLength(1);
        expect(daemon.interactions[0]).toMatchObject({
          cascadeId: conversationId,
          interaction: {
            trajectoryId: "traj-1",
            stepIndex: 0,
            permission: { allow: true, scope: "PERMISSION_SCOPE_ONCE" },
          },
        });
      } finally {
        await Effect.runPromise(adapter.stopSession(threadId)).catch(() => undefined);
        await Effect.runPromise(Fiber.interrupt(collector)).catch(() => undefined);
      }
    } finally {
      await daemon.close().catch(() => undefined);
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
