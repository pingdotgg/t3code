import type { ProviderKind } from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, Stream } from "effect";

import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: {
    sessionModelSwitch: "in-session",
    commandExecutionTermination: "unsupported",
  },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  terminateCommandExecution: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  compactThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeCodeAdapter: ClaudeCodeAdapterShape = {
  ...fakeCodexAdapter,
  provider: "claudeCode",
};

const fakeCursorAdapter: CursorAdapterShape = {
  ...fakeCodexAdapter,
  provider: "cursor",
};

const layer = it.layer(
  Layer.mergeAll(
    ProviderAdapterRegistryLive.pipe(
      Layer.provideMerge(Layer.succeed(CodexAdapter, fakeCodexAdapter)),
      Layer.provideMerge(Layer.succeed(ClaudeCodeAdapter, fakeClaudeCodeAdapter)),
      Layer.provideMerge(Layer.succeed(CursorAdapter, fakeCursorAdapter)),
    ),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      assert.equal(codex, fakeCodexAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex", "claudeCode", "cursor"]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});
