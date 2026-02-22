import { describe, expect, it } from "vitest";

import { Effect, Layer, ManagedRuntime, Option } from "effect";

import {
  ProviderAdapterValidationError,
  ProviderFilesystemError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
  type ProviderServiceError,
} from "./Errors.ts";
import {
  CheckpointValidationError,
  type CheckpointCatalogError,
  type CheckpointServiceError,
  type CheckpointStoreError,
} from "../checkpointing/Errors.ts";
import { CheckpointCatalog } from "../checkpointing/Services/CheckpointCatalog.ts";
import { CheckpointService } from "../checkpointing/Services/CheckpointService.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { CodexAdapter } from "./Services/CodexAdapter.ts";
import { ProviderAdapterRegistry } from "./Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";

describe("provider/checkpoint service contracts", () => {
  it("resolves all service tags from ServiceMap", async () => {
    const providerLive: typeof ProviderService.Service = {
      startSession: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      sendTurn: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      interruptTurn: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      respondToRequest: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      listCheckpoints: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      getCheckpointDiff: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      revertToCheckpoint: () =>
        Effect.fail<ProviderServiceError>(new ProviderUnsupportedError({ provider: "x" })),
      stopAll: () => Effect.void,
      subscribeToEvents: () => Effect.succeed(() => undefined),
    };

    const codexLive: typeof CodexAdapter.Service = {
      provider: "codex",
      startSession: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "startSession",
            issue: "not implemented",
          }),
        ),
      sendTurn: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "sendTurn",
            issue: "not implemented",
          }),
        ),
      interruptTurn: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "interruptTurn",
            issue: "not implemented",
          }),
        ),
      readThread: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "readThread",
            issue: "not implemented",
          }),
        ),
      rollbackThread: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "rollbackThread",
            issue: "not implemented",
          }),
        ),
      respondToRequest: () =>
        Effect.fail<ProviderAdapterError>(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "respondToRequest",
            issue: "not implemented",
          }),
        ),
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      stopAll: () => Effect.void,
      subscribeToEvents: () => Effect.succeed(() => undefined),
    };

    const checkpointStoreLive: typeof CheckpointStore.Service = {
      isGitRepository: () => Effect.succeed(false),
      captureCheckpoint: () => Effect.void,
      hasCheckpoint: () => Effect.succeed(false),
      ensureRootCheckpoint: () => Effect.succeed(false),
      restoreCheckpoint: () => Effect.succeed(false),
      diffCheckpoints: () =>
        Effect.fail<CheckpointStoreError>(
          new CheckpointValidationError({
            operation: "diffCheckpoints",
            issue: "not implemented",
          }),
        ),
      pruneAfterTurn: () => Effect.void,
    };

    const checkpointCatalogLive: typeof CheckpointCatalog.Service = {
      upsertCheckpoint: () => Effect.void,
      listCheckpoints: () => Effect.succeed([]),
      getCheckpoint: () => Effect.succeed(Option.none()),
      deleteAfterTurn: () => Effect.void,
      deleteAllForSession: () => Effect.void,
    };

    const checkpointServiceLive: typeof CheckpointService.Service = {
      initializeForSession: () => Effect.void,
      captureCurrentTurn: () => Effect.void,
      listCheckpoints: () =>
        Effect.fail<CheckpointServiceError>(
          new CheckpointValidationError({ operation: "listCheckpoints", issue: "not implemented" }),
        ),
      getCheckpointDiff: () =>
        Effect.fail<CheckpointServiceError>(
          new CheckpointValidationError({
            operation: "getCheckpointDiff",
            issue: "not implemented",
          }),
        ),
      revertToCheckpoint: () =>
        Effect.fail<CheckpointServiceError>(
          new CheckpointValidationError({
            operation: "revertToCheckpoint",
            issue: "not implemented",
          }),
        ),
    };

    const providerAdapterRegistryLive: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codexLive)
          : Effect.fail<ProviderUnsupportedError>(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const providerSessionDirectoryLive: typeof ProviderSessionDirectory.Service = {
      upsert: () => Effect.void,
      getProvider: (sessionId) =>
        Effect.fail<ProviderSessionNotFoundError>(new ProviderSessionNotFoundError({ sessionId })),
      getThreadId: (sessionId) =>
        Effect.fail<ProviderSessionNotFoundError>(new ProviderSessionNotFoundError({ sessionId })),
      remove: () => Effect.void,
      listSessionIds: () => Effect.succeed([]),
    };

    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(ProviderService, providerLive),
        Layer.succeed(CodexAdapter, codexLive),
        Layer.succeed(CheckpointStore, checkpointStoreLive),
        Layer.succeed(CheckpointCatalog, checkpointCatalogLive),
        Layer.succeed(CheckpointService, checkpointServiceLive),
        Layer.succeed(ProviderAdapterRegistry, providerAdapterRegistryLive),
        Layer.succeed(ProviderSessionDirectory, providerSessionDirectoryLive),
      ),
    );

    const [
      provider,
      codex,
      checkpointStore,
      checkpointCatalog,
      checkpointService,
      providerAdapterRegistry,
      providerSessionDirectory,
    ] = await Promise.all([
      runtime.runPromise(Effect.service(ProviderService)),
      runtime.runPromise(Effect.service(CodexAdapter)),
      runtime.runPromise(Effect.service(CheckpointStore)),
      runtime.runPromise(Effect.service(CheckpointCatalog)),
      runtime.runPromise(Effect.service(CheckpointService)),
      runtime.runPromise(Effect.service(ProviderAdapterRegistry)),
      runtime.runPromise(Effect.service(ProviderSessionDirectory)),
    ]);

    expect(provider).toBe(providerLive);
    expect(codex).toBe(codexLive);
    expect(checkpointStore).toBe(checkpointStoreLive);
    expect(checkpointCatalog).toBe(checkpointCatalogLive);
    expect(checkpointService).toBe(checkpointServiceLive);
    expect(providerAdapterRegistry).toBe(providerAdapterRegistryLive);
    expect(providerSessionDirectory).toBe(providerSessionDirectoryLive);

    await runtime.dispose();
  });
});

describe("provider/checkpoint errors", () => {
  it("preserves cause and message on tagged errors", () => {
    const fsCause = new Error("filesystem failed");
    const fsError = new ProviderFilesystemError({
      sessionId: "sess-1",
      detail: "capture failed",
      cause: fsCause,
    });

    expect(fsError._tag).toBe("ProviderFilesystemError");
    expect(fsError.message).toContain("sess-1");
    expect(fsError.cause).toBe(fsCause);
  });

  it("accepts checkpoint catalog error channel type", () => {
    const error: CheckpointCatalogError = new CheckpointValidationError({
      operation: "upsertCheckpoint",
      issue: "turnCount must be >= 0",
    });

    expect(error._tag).toBe("CheckpointValidationError");
  });
});
