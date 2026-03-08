import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { ThreadId, TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";

import { GeminiCliServerManager } from "./geminiCliServerManager";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

// ---------------------------------------------------------------------------
// Helpers to inspect spawned processes
// ---------------------------------------------------------------------------

/** Minimal mock for ChildProcess returned by `spawn`. */
function createMockChildProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: { write: vi.fn() },
    kill: vi.fn(),
    pid: 12345,
  });
  return child;
}

/** Capture spawn calls so we can inspect args & feed fake output. */
function mockSpawn() {
  const children: ReturnType<typeof createMockChildProcess>[] = [];
  const spawnMock = vi.fn((_cmd: string, _args: string[]) => {
    const child = createMockChildProcess();
    children.push(child);
    return child;
  });
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  return { spawnMock, children };
}

/** Feed a line of JSON to the child's stdout as if it were a readline event. */
function feedStdoutLine(
  child: ReturnType<typeof createMockChildProcess>,
  json: Record<string, unknown>,
): void {
  // Simulate readline "line" event by emitting data that includes a newline.
  // Since we use readline.createInterface on stdout, we emit raw data.
  child.stdout.emit("data", Buffer.from(JSON.stringify(json) + "\n"));
}

// ---------------------------------------------------------------------------
// Unit tests — no real gemini process
// ---------------------------------------------------------------------------

describe("GeminiCliServerManager", () => {
  describe("startSession", () => {
    it("creates a session and returns a ready ProviderSession", async () => {
      const manager = new GeminiCliServerManager();
      try {
        const session = await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
          cwd: "/tmp",
          model: "gemini-2.5-pro",
        });

        expect(session.provider).toBe("geminiCli");
        expect(session.status).toBe("ready");
        expect(session.threadId).toBe("thread-1");
        expect(session.model).toBe("gemini-2.5-pro");
        expect(manager.hasSession(asThreadId("thread-1"))).toBe(true);
      } finally {
        manager.stopAll();
      }
    });

    it("rejects duplicate sessions", async () => {
      const manager = new GeminiCliServerManager();
      try {
        await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
        });

        expect(() =>
          manager.startSession({
            threadId: asThreadId("thread-1"),
            provider: "geminiCli",
            runtimeMode: "full-access",
          }),
        ).toThrow("already exists");
      } finally {
        manager.stopAll();
      }
    });

    // TODO: Strengthen this test by mocking child_process.spawn and asserting it
    // is NOT called during startSession. Currently we only verify session state,
    // which doesn't prove that no process was spawned.
    it("does not spawn a process on startSession (lazy per-turn spawning)", async () => {
      const manager = new GeminiCliServerManager();
      try {
        await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
        });

        // No process should exist yet — we only spawn on sendTurn.
        expect(manager.listSessions()).toHaveLength(1);
        expect(manager.listSessions()[0]?.status).toBe("ready");
      } finally {
        manager.stopAll();
      }
    });
  });

  describe("sendTurn", () => {
    it("rejects when session does not exist", () => {
      const manager = new GeminiCliServerManager();
      expect(() =>
        manager.sendTurn({
          threadId: asThreadId("nonexistent"),
          input: "hello",
        }),
      ).toThrow("Unknown Gemini CLI session");
    });

    it("rejects when session is closed", async () => {
      const manager = new GeminiCliServerManager();
      await manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "geminiCli",
        runtimeMode: "full-access",
      });

      // Directly mark the session as closed without removing it from the map,
      // so we exercise the "closed session" branch (not the "unknown session" branch).
      const sessions = (
        manager as unknown as { sessions: Map<string, { status: string }> }
      ).sessions;
      const session = sessions.get("thread-1");
      expect(session).toBeDefined();
      session!.status = "closed";

      expect(() =>
        manager.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
        }),
      ).toThrow("Gemini CLI session is closed");
    });

    it("rejects when session is already running", async () => {
      const manager = new GeminiCliServerManager();
      await manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "geminiCli",
        runtimeMode: "full-access",
      });

      // Mark the session as running to simulate an in-progress turn.
      const sessions = (
        manager as unknown as { sessions: Map<string, { status: string }> }
      ).sessions;
      const session = sessions.get("thread-1");
      expect(session).toBeDefined();
      session!.status = "running";

      expect(() =>
        manager.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
        }),
      ).toThrow("Gemini CLI session already running");
    });

    it("rejects when attachments are provided", async () => {
      const manager = new GeminiCliServerManager();
      try {
        await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
        });

        expect(() =>
          manager.sendTurn({
            threadId: asThreadId("thread-1"),
            input: "hello",
            attachments: [{ type: "image", url: "https://example.com/img.png" }] as never,
          }),
        ).toThrow("does not support attachments");
      } finally {
        manager.stopAll();
      }
    });
  });

  describe("stopSession", () => {
    it("removes the session", async () => {
      const manager = new GeminiCliServerManager();
      await manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "geminiCli",
        runtimeMode: "full-access",
      });

      expect(manager.hasSession(asThreadId("thread-1"))).toBe(true);
      manager.stopSession(asThreadId("thread-1"));
      expect(manager.hasSession(asThreadId("thread-1"))).toBe(false);
    });

    it("is a no-op for unknown sessions", () => {
      const manager = new GeminiCliServerManager();
      expect(() => manager.stopSession(asThreadId("nonexistent"))).not.toThrow();
    });
  });

  describe("listSessions / hasSession", () => {
    it("lists all active sessions", async () => {
      const manager = new GeminiCliServerManager();
      try {
        await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
          model: "gemini-3-flash",
        });
        await manager.startSession({
          threadId: asThreadId("thread-2"),
          provider: "geminiCli",
          runtimeMode: "full-access",
          model: "gemini-2.5-pro",
        });

        const sessions = manager.listSessions();
        expect(sessions).toHaveLength(2);
        expect(sessions.map((s) => s.threadId).sort()).toEqual(["thread-1", "thread-2"]);
      } finally {
        manager.stopAll();
      }
    });
  });

  describe("readThread / rollbackThread", () => {
    it("returns empty turns for a valid session", async () => {
      const manager = new GeminiCliServerManager();
      try {
        await manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "geminiCli",
          runtimeMode: "full-access",
        });

        const snapshot = await manager.readThread(asThreadId("thread-1"));
        expect(snapshot.threadId).toBe("thread-1");
        expect(snapshot.turns).toEqual([]);
      } finally {
        manager.stopAll();
      }
    });

    it("throws for unknown sessions", () => {
      const manager = new GeminiCliServerManager();
      expect(() => manager.readThread(asThreadId("nonexistent"))).toThrow(
        "Unknown Gemini CLI session",
      );
    });
  });

  describe("interruptTurn", () => {
    it("throws for unknown sessions", () => {
      const manager = new GeminiCliServerManager();
      expect(() => manager.interruptTurn(asThreadId("nonexistent"))).toThrow(
        "Unknown Gemini CLI session",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// handleJsonLine — test event mapping from Gemini stream-json to provider events
// ---------------------------------------------------------------------------

describe("GeminiCliServerManager JSON event mapping", () => {
  let manager: GeminiCliServerManager;
  let events: ProviderRuntimeEvent[];

  beforeEach(async () => {
    manager = new GeminiCliServerManager();
    events = [];
    manager.on("event", (event) => events.push(event));

    await manager.startSession({
      threadId: asThreadId("thread-json"),
      provider: "geminiCli",
      runtimeMode: "full-access",
      model: "gemini-2.5-pro",
      cwd: "/tmp",
    });
  });

  /** Invoke the private handleJsonLine method for testing. */
  function feedJsonLine(line: string): void {
    const turnId = TurnId.makeUnsafe("test-turn-1");
    (
      manager as unknown as {
        handleJsonLine: (threadId: ThreadId, turnId: TurnId, line: string) => void;
      }
    ).handleJsonLine(asThreadId("thread-json"), turnId, line);
  }

  it("captures gemini session_id from init event", () => {
    feedJsonLine(
      JSON.stringify({
        type: "init",
        session_id: "gemini-sess-abc",
        model: "gemini-2.5-pro",
        timestamp: new Date().toISOString(),
      }),
    );

    // init doesn't emit a provider event, but we can verify the session ID
    // was captured by checking that a subsequent sendTurn would use --resume.
    expect(events).toHaveLength(0);

    // Verify the session_id was actually stored for --resume on subsequent turns.
    const sessions = (manager as unknown as { sessions: Map<string, { geminiSessionId?: string }> }).sessions;
    expect(sessions.get("thread-json")?.geminiSessionId).toBe("gemini-sess-abc");
  });

  it("maps assistant message deltas to content.delta events with stable itemId", () => {
    feedJsonLine(
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "Hello, ",
        delta: true,
        timestamp: new Date().toISOString(),
      }),
    );
    feedJsonLine(
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "world!",
        delta: true,
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("content.delta");
    expect(events[0]?.provider).toBe("geminiCli");
    expect((events[0]?.payload as { delta: string }).delta).toBe("Hello, ");
    expect((events[0]?.payload as { streamKind: string }).streamKind).toBe("assistant_text");

    // Both deltas must share the same itemId for proper message aggregation.
    expect(events[1]?.type).toBe("content.delta");
    expect((events[1] as { itemId?: string }).itemId).toBe(
      (events[0] as { itemId?: string }).itemId,
    );
  });

  it("ignores user message echoes", () => {
    feedJsonLine(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "Say hello",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(0);
  });

  it("maps tool_use to item.started events with descriptive title", () => {
    feedJsonLine(
      JSON.stringify({
        type: "tool_use",
        tool_name: "list_directory",
        tool_id: "tool_123",
        parameters: { dir_path: "." },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("item.started");
    const payload = events[0]?.payload as { itemType: string; title: string };
    expect(payload.itemType).toBe("command_execution");
    expect(payload.title).toBe("list_directory · .");
  });

  it("maps tool_result to item.completed events with descriptive title and detail", () => {
    // First emit tool_use to register the tool item.
    feedJsonLine(
      JSON.stringify({
        type: "tool_use",
        tool_name: "read_file",
        tool_id: "tool_456",
        parameters: { file_path: "README.md" },
        timestamp: new Date().toISOString(),
      }),
    );

    // Then the result with output.
    feedJsonLine(
      JSON.stringify({
        type: "tool_result",
        tool_id: "tool_456",
        status: "success",
        output: "File contents here",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("item.completed");
    const payload = events[1]?.payload as {
      itemType: string;
      status: string;
      title: string;
      detail: string;
    };
    expect(payload.itemType).toBe("command_execution");
    expect(payload.status).toBe("completed");
    expect(payload.title).toBe("read_file · README.md");
    expect(payload.detail).toBe("File contents here");
  });

  it("falls back to parameter summary when tool output is empty", () => {
    feedJsonLine(
      JSON.stringify({
        type: "tool_use",
        tool_name: "read_file",
        tool_id: "tool_789",
        parameters: { file_path: "package.json" },
        timestamp: new Date().toISOString(),
      }),
    );

    feedJsonLine(
      JSON.stringify({
        type: "tool_result",
        tool_id: "tool_789",
        status: "success",
        output: "",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(2);
    const payload = events[1]?.payload as { title: string; detail?: string };
    expect(payload.title).toBe("read_file · package.json");
    expect(payload.detail).toBe('{"file_path":"package.json"}');
  });

  it("maps result success to turn.completed with state=completed", () => {
    feedJsonLine(
      JSON.stringify({
        type: "result",
        status: "success",
        stats: {
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          duration_ms: 3000,
          tool_calls: 1,
        },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.completed");
    const payload = events[0]?.payload as { state: string; usage?: unknown };
    expect(payload.state).toBe("completed");
    expect(payload.usage).toEqual({
      total_tokens: 1000,
      input_tokens: 800,
      output_tokens: 200,
      cached_tokens: undefined,
      duration_ms: 3000,
      tool_calls: 1,
    });
  });

  it("maps result error to turn.completed with state=failed", () => {
    feedJsonLine(
      JSON.stringify({
        type: "result",
        status: "error",
        error_message: "Rate limit exceeded",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.completed");
    const payload = events[0]?.payload as { state: string; errorMessage?: string };
    expect(payload.state).toBe("failed");
    expect(payload.errorMessage).toBe("Rate limit exceeded");
  });

  it("maps result error with nested error object to turn.completed with errorMessage", () => {
    feedJsonLine(
      JSON.stringify({
        type: "result",
        status: "error",
        error: { type: "Error", message: "[API Error: Requested entity was not found.]" },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.completed");
    const payload = events[0]?.payload as { state: string; errorMessage?: string };
    expect(payload.state).toBe("failed");
    expect(payload.errorMessage).toBe("[API Error: Requested entity was not found.]");
  });

  it("maps result interrupted to turn.completed with state=interrupted", () => {
    feedJsonLine(
      JSON.stringify({
        type: "result",
        status: "interrupted",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { state: string };
    expect(payload.state).toBe("interrupted");
  });

  it("ignores non-JSON lines", () => {
    feedJsonLine("YOLO mode is enabled.");
    feedJsonLine("Loaded cached credentials.");
    feedJsonLine("Skill conflict detected: ...");
    feedJsonLine("");
    feedJsonLine("   ");

    expect(events).toHaveLength(0);
  });

  it("ignores malformed JSON", () => {
    feedJsonLine("{broken json");
    expect(events).toHaveLength(0);
  });

  it("handles a full conversation flow in sequence", () => {
    const lines = [
      '{"type":"init","timestamp":"2026-03-08T09:10:06.236Z","session_id":"sess-1","model":"gemini-3-flash"}',
      '{"type":"message","timestamp":"2026-03-08T09:10:06.237Z","role":"user","content":"Hello"}',
      '{"type":"message","timestamp":"2026-03-08T09:10:09.823Z","role":"assistant","content":"Hi there!","delta":true}',
      '{"type":"message","timestamp":"2026-03-08T09:10:09.900Z","role":"assistant","content":" How can I help?","delta":true}',
      '{"type":"tool_use","timestamp":"2026-03-08T09:10:10.000Z","tool_name":"list_directory","tool_id":"tool_1","parameters":{"dir_path":"."}}',
      '{"type":"tool_result","timestamp":"2026-03-08T09:10:10.100Z","tool_id":"tool_1","status":"success","output":"3 items"}',
      '{"type":"message","timestamp":"2026-03-08T09:10:11.000Z","role":"assistant","content":"Found 3 items.","delta":true}',
      '{"type":"result","timestamp":"2026-03-08T09:10:11.100Z","status":"success","stats":{"total_tokens":500,"input_tokens":400,"output_tokens":100,"duration_ms":5000,"tool_calls":1}}',
    ];

    for (const line of lines) {
      feedJsonLine(line);
    }

    // Expected events:
    //   2 content.delta (segment 1) + 1 item.completed (assistant_message, segment 1 finalized by tool_use)
    //   + 1 item.started + 1 item.completed (tool)
    //   + 1 content.delta (segment 2) + 1 item.completed (assistant_message, segment 2 finalized by result)
    //   + 1 turn.completed = 8
    expect(events).toHaveLength(8);
    expect(events.map((e) => e.type)).toEqual([
      "content.delta",       // "Hi there!" (segment 1)
      "content.delta",       // " How can I help?" (segment 1)
      "item.completed",      // assistant_message finalized (segment 1)
      "item.started",        // tool_use list_directory
      "item.completed",      // tool_result list_directory
      "content.delta",       // "Found 3 items." (segment 2)
      "item.completed",      // assistant_message finalized (segment 2)
      "turn.completed",
    ]);

    // Deltas before the tool call share one itemId (segment 1),
    // and the delta after the tool call gets a new itemId (segment 2).
    const deltas = events.filter((e) => e.type === "content.delta");
    const deltaItemIds = deltas.map((e) => (e as { itemId?: string }).itemId);
    expect(new Set(deltaItemIds).size).toBe(2);
    // First two deltas share the same itemId.
    expect(deltaItemIds[0]).toBe(deltaItemIds[1]);
    // Third delta has a different itemId.
    expect(deltaItemIds[2]).not.toBe(deltaItemIds[0]);

    // Both assistant_message completions are present.
    const assistantCompletes = events.filter(
      (e) =>
        e.type === "item.completed" &&
        (e.payload as { itemType?: string }).itemType === "assistant_message",
    );
    expect(assistantCompletes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Live integration test — only runs when `gemini` is available
// ---------------------------------------------------------------------------

const hasGemini = await (async () => {
  try {
    const { execSync } = await import("node:child_process");
    execSync("gemini --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGemini || process.env.RUN_GEMINI_LIVE_TESTS !== "1")(
  "GeminiCliServerManager live integration",
  () => {
    it(
      "sends a prompt and receives streaming events ending with turn.completed",
      async () => {
        const manager = new GeminiCliServerManager();
        const events: ProviderRuntimeEvent[] = [];
        manager.on("event", (event) => events.push(event));

        try {
          await manager.startSession({
            threadId: asThreadId("live-thread"),
            provider: "geminiCli",
            runtimeMode: "full-access",
            model: "gemini-2.5-flash",
          });

          const result = await manager.sendTurn({
            threadId: asThreadId("live-thread"),
            input: "Reply with exactly the word PONG",
          });

          expect(result.threadId).toBe("live-thread");
          expect(result.turnId).toBeTruthy();

          // Wait for the turn to complete.
          await vi.waitFor(
            () => {
              const completed = events.find((e) => e.type === "turn.completed");
              expect(completed).toBeDefined();
            },
            { timeout: 30_000, interval: 500 },
          );

          // Should have received content deltas.
          const deltas = events.filter((e) => e.type === "content.delta");
          expect(deltas.length).toBeGreaterThan(0);

          // The text should contain "PONG" somewhere.
          const fullText = deltas
            .map((e) => (e.payload as { delta: string }).delta)
            .join("");
          expect(fullText.toLowerCase()).toContain("pong");

          // Turn should be completed successfully.
          const completed = events.find((e) => e.type === "turn.completed");
          expect((completed?.payload as { state: string }).state).toBe("completed");
        } finally {
          manager.stopAll();
        }
      },
      60_000,
    );
  },
);
