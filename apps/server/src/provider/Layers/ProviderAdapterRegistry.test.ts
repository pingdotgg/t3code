import type { ProviderKind } from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer } from "effect";

import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { makeProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  subscribeToEvents: vi.fn(),
};

const layer = it.layer(
  makeProviderAdapterRegistryLive().pipe(
    Layer.provide(Layer.succeed(CodexAdapter, fakeCodexAdapter)),
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("codex");
      assert.equal(adapter, fakeCodexAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex"]);
    }));

  it("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }));
});
