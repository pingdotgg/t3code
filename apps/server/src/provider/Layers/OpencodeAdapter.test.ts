import { ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { OpencodeAdapter } from "../Services/OpencodeAdapter.ts";
import { OpencodeAdapterLive } from "./OpencodeAdapter.ts";
import { ServerConfig } from "../../config.ts";

const mockManager = {
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  stopAll: vi.fn(),
  on: vi.fn(),
};

vi.mock("../../opencodeCliManager.ts", () => ({
  OpencodeCliManager: vi.fn(function () {
    return mockManager;
  }),
}));

describe("OpencodeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a session successfully", async () => {
    mockManager.startSession.mockResolvedValue({
      threadId: "test-thread",
      model: "opencode-1",
      cwd: "/test",
      opencodeSessionId: "opencode-session-123",
      status: "idle"
    });

    const program = Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const result = yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("test-thread"),
        runtimeMode: "full-access",
        cwd: "/test",
        model: "opencode-1",
      });

      expect(result.provider).toBe("opencode");
      expect(result.status).toBe("ready");
      expect(result.threadId).toBe("test-thread");
    }).pipe(
      Effect.provide(OpencodeAdapterLive),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });

  it("maps events from manager to canonical format", async () => {
    let eventCallback: any;
    mockManager.on.mockImplementation((event, cb) => {
      if (event === "event") {
        eventCallback = cb;
      }
    });

    const program = Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const stream = adapter.streamEvents;

      setTimeout(() => {
        eventCallback({
          method: "turn/started",
          threadId: "test-thread",
          turnId: "test-turn",
          model: "opencode-1"
        });
      }, 10);

      const option = yield* Stream.runHead(stream);
      expect(option._tag).toBe("Some");
      if (option._tag === "Some") {
        expect(option.value.type).toBe("turn.started");
      }
    }).pipe(
      Effect.provide(OpencodeAdapterLive),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });

  it("maps tool_update and tool_result events correctly", async () => {
    let eventCallback: any;
    mockManager.on.mockImplementation((event, cb) => {
      if (event === "event") {
        eventCallback = cb;
      }
    });

    const program = Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const stream = adapter.streamEvents;

      setTimeout(() => {
        eventCallback({
          method: "opencode/tool_update",
          threadId: "test-thread",
          turnId: "test-turn",
          tool_id: "tool-1",
          tool_name: "test_tool",
          status: "in_progress",
          output: "Working..."
        });
        
        setTimeout(() => {
           eventCallback({
            method: "opencode/tool_result",
            threadId: "test-thread",
            turnId: "test-turn",
            tool_id: "tool-1",
            tool_name: "test_tool",
            status: "completed",
            output: "Success"
          });
        }, 10);
      }, 10);

      const events = yield* Stream.runCollect(Stream.take(stream, 2));
      expect(events.length).toBe(2);
      expect(Array.from(events)[0]?.type).toBe("item.updated");
      expect(Array.from(events)[1]?.type).toBe("item.completed");
    }).pipe(
      Effect.provide(OpencodeAdapterLive),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });
});
