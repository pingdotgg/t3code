import assert from "node:assert/strict";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";
import { checkOpencodeProviderStatus } from "./ProviderHealth.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type OpencodeClient } from "@opencode-ai/sdk";
import { Sink } from "effect";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.succeed(undefined),
  getProvider: () => Effect.die(new Error("unused")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.succeed(undefined),
  listThreadIds: () => Effect.succeed([]),
});

type PromptInput = {
  readonly body: {
    readonly model: {
      readonly providerID: string;
      readonly modelID: string;
    };
  };
};

const mockSubscribe = vi.fn(async () => ({
  stream: (async function* () {
    yield {
      type: "message.part.updated",
      properties: {
        part: { id: "part-1", type: "text" },
        delta: "hello",
      },
    };
    yield {
      type: "session.updated",
      properties: {
        info: { id: "session-1" },
      },
    };
  })(),
}));

const mockPrompt = vi.fn(async (_input: PromptInput) => ({
  data: { info: { id: "msg-1" }, parts: [] },
}));
const mockAbort = vi.fn(async () => ({ data: true }));
const mockCreate = vi.fn(async () => ({ data: { id: "session-1" } }));
const mockDelete = vi.fn(async () => ({ data: true }));
const mockClose = vi.fn(() => undefined);

type OpenCodeInstanceMock = {
  readonly client: OpencodeClient;
  readonly server: {
    readonly url: string;
    close(): void;
  };
};

const testLayer = it.layer(
  makeOpenCodeAdapterLive({
    createClient: async () =>
      ({
        client: {
          session: {
            create: mockCreate,
            prompt: mockPrompt,
            abort: mockAbort,
            delete: mockDelete,
          },
          event: {
            subscribe: mockSubscribe,
          },
        },
        server: {
          url: "http://127.0.0.1:4096",
          close: mockClose,
        },
      }) as unknown as OpenCodeInstanceMock,
  }).pipe(
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

testLayer("OpenCodeAdapterLive", (it) => {
  afterAll(() => {
    vi.clearAllMocks();
  });

  it.effect("startSession creates a session and returns ProviderSession", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const session = yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "opencode");
      assert.equal(session.threadId, "thread-1");
      assert.equal(mockCreate.mock.calls.length, 1);
    }),
  );

  it.effect("sendTurn emits content.delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId: asThreadId("thread-2"), input: "hi" });
      const event = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(event._tag, "Some");
      if (event._tag !== "Some") return;
      assert.equal(event.value.type, "turn.started");
    }),
  );

  it.effect("interruptTurn calls abort", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-3"),
        runtimeMode: "full-access",
      });

      yield* adapter.interruptTurn(asThreadId("thread-3"));
      assert.equal(mockAbort.mock.calls.length > 0, true);
    }),
  );

  it.effect("model alias 'sonnet' resolves to anthropic/claude-sonnet-4-5", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-4"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: asThreadId("thread-4"), input: "hi", model: "sonnet" });
      const promptCall = mockPrompt.mock.calls.at(-1);
      assert.equal(promptCall !== undefined, true);
      const promptInput = promptCall?.[0] as PromptInput | undefined;
      assert.equal(promptInput !== undefined, true);
      assert.deepEqual(promptInput?.body.model, {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      });
    }),
  );
});

it.effect("health probe reports opencode availability", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const status = yield* checkOpencodeProviderStatus.pipe(
      Effect.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
            void cmd;
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.succeed(undefined),
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode("opencode 0.1.0")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
      ),
    );

    assert.equal(status.provider, "opencode");
    assert.equal(status.available, true);
  }),
);
