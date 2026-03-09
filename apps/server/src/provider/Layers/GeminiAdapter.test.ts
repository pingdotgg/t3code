import { ThreadId } from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { GeminiAdapterLive } from "./GeminiAdapter.ts";
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

vi.mock("../../geminiCliManager.ts", () => ({
  GeminiCliManager: vi.fn(function () {
    return mockManager;
  }),
}));

describe("GeminiAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a session successfully", async () => {
    mockManager.startSession.mockReturnValue({
      threadId: "test-thread",
      model: "gemini-2.5-pro",
      cwd: "/test",
      geminiSessionId: "gemini-session-123",
      status: "idle"
    });

    const program = Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      const result = yield* adapter.startSession({
        threadId: ThreadId.makeUnsafe("test-thread"),
        runtimeMode: "full-access",
        cwd: "/test",
        model: "gemini-2.5-pro",
      });

      expect(result.provider).toBe("gemini");
      expect(result.status).toBe("ready");
      expect(result.threadId).toBe("test-thread");
      expect(result.resumeCursor).toEqual({ sessionId: "gemini-session-123" });
    }).pipe(
      Effect.provide(GeminiAdapterLive),
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });

  it("handles turn submission errors correctly", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      
      const res = yield* Effect.flip(adapter.sendTurn({
        threadId: ThreadId.makeUnsafe("test-thread"),
        input: "",
      } as any));

      expect(res).toBeInstanceOf(ProviderAdapterRequestError);
      expect((res as any).detail).toBe("Turn input must include text.");
    }).pipe(
      Effect.provide(GeminiAdapterLive),
      Effect.provide(NodeFileSystem.layer),
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
      const adapter = yield* GeminiAdapter;
      
      const stream = adapter.streamEvents;

      // Trigger a raw event asynchronously
      setTimeout(() => {
        eventCallback({
          method: "turn/started",
          threadId: "test-thread",
          turnId: "test-turn",
          model: "gemini-2.5-pro"
        });
      }, 10);

      const option = yield* Stream.runHead(stream);
      expect(option._tag).toBe("Some");
      if (option._tag === "Some") {
        const received = option.value;
        expect(received.type).toBe("turn.started");
        expect(received.provider).toBe("gemini");
        expect(received.payload).toEqual({ model: "gemini-2.5-pro" });
      }

    }).pipe(
      Effect.provide(GeminiAdapterLive),
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });
  
  it("stops session correctly", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      yield* adapter.stopSession(ThreadId.makeUnsafe("test-thread"));
      expect(mockManager.stopSession).toHaveBeenCalledWith("test-thread");
    }).pipe(
      Effect.provide(GeminiAdapterLive),
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });

  it("interrupts turn correctly", async () => {
    const program = Effect.gen(function* () {
      const adapter = yield* GeminiAdapter;
      yield* adapter.interruptTurn(ThreadId.makeUnsafe("test-thread"));
      expect(mockManager.interruptTurn).toHaveBeenCalledWith("test-thread");
    }).pipe(
      Effect.provide(GeminiAdapterLive),
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(ServerConfig, { stateDir: "/tmp" } as any)
    );

    await Effect.runPromise(program);
  });
});
