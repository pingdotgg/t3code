import { describe, expect, it } from "vitest";

import { Effect, Layer, ManagedRuntime } from "effect";

import {
  CheckpointValidationError,
  CodexValidationError,
  ProviderFilesystemError,
  ProviderUnsupportedError,
  type CheckpointStoreError,
  type CodexServiceError,
  type ProviderServiceError,
} from "./Errors.ts";
import { CheckpointStore } from "./Services/CheckpointStore.ts";
import { CodexService } from "./Services/Codex.ts";
import { ProviderService } from "./Services/Provider.ts";

describe("provider service contracts", () => {
  it("resolves provider, codex, and checkpoint services from ServiceMap tags", async () => {
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
      dispose: () => Effect.void,
      subscribeToEvents: () => Effect.succeed(() => undefined),
    };

    const codexLive: typeof CodexService.Service = {
      startSession: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "startSession", issue: "not implemented" }),
        ),
      sendTurn: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "sendTurn", issue: "not implemented" }),
        ),
      interruptTurn: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "interruptTurn", issue: "not implemented" }),
        ),
      readThread: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "readThread", issue: "not implemented" }),
        ),
      rollbackThread: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "rollbackThread", issue: "not implemented" }),
        ),
      respondToRequest: () =>
        Effect.fail<CodexServiceError>(
          new CodexValidationError({ operation: "respondToRequest", issue: "not implemented" }),
        ),
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      stopAll: () => Effect.void,
      subscribeToEvents: () => Effect.succeed(() => undefined),
    };

    const checkpointLive: typeof CheckpointStore.Service = {
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

    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(ProviderService, providerLive),
        Layer.succeed(CodexService, codexLive),
        Layer.succeed(CheckpointStore, checkpointLive),
      ),
    );

    const [provider, codex, checkpoint] = await Promise.all([
      runtime.runPromise(Effect.service(ProviderService)),
      runtime.runPromise(Effect.service(CodexService)),
      runtime.runPromise(Effect.service(CheckpointStore)),
    ]);

    expect(provider).toBe(providerLive);
    expect(codex).toBe(codexLive);
    expect(checkpoint).toBe(checkpointLive);

    await runtime.dispose();
  });
});

describe("provider error taxonomy", () => {
  it("keeps defect cause and message on tagged errors", () => {
    const cause = new Error("filesystem failed");
    const error = new ProviderFilesystemError({
      sessionId: "sess-1",
      detail: "capture failed",
      cause,
    });

    expect(error._tag).toBe("ProviderFilesystemError");
    expect(error.message).toContain("sess-1");
    expect(error.cause).toBe(cause);
  });
});
