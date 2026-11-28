import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  create: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  createAttachmentEnvironmentAtoms: () => ({
    createUploadUrl: { label: "create", run: state.create },
    remove: { label: "remove", run: state.remove },
  }),
}));

import { attachmentEnvironment } from "./attachments";

const environmentId = EnvironmentId.make("secondary");
const registry = AtomRegistry.make();
beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.create.mockReset().mockReturnValue(
    Effect.succeed({
      attachmentId: "pending",
      relativeUrl: "/upload",
      expiresAt: 1,
    }),
  );
  state.remove.mockReset().mockReturnValue(Effect.void);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachment mutation grants", () => {
  it.effect("uses the attachment environment for both mint and deletion", () =>
    Effect.gen(function* () {
      const mintResult = yield* Effect.exit(
        attachmentEnvironment.createUploadUrl.run(registry, {
          environmentId,
          input: { name: "image.png", mimeType: "image/png", sizeBytes: 1 },
        }),
      );
      const removeResult = yield* Effect.exit(
        attachmentEnvironment.remove.run(registry, {
          environmentId,
          input: { attachmentId: "pending" },
        }),
      );
      for (const result of [mintResult, removeResult]) {
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("Expected permission denial");
        const error = Cause.squash<unknown>(result.cause);
        expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
        expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      }
      expect(state.create).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      state.grantedEnvironments.add("secondary");
      expect(
        (yield* Effect.exit(
          attachmentEnvironment.remove.run(registry, {
            environmentId,
            input: { attachmentId: "pending" },
          }),
        ))._tag,
      ).toBe("Success");
      expect(state.remove).toHaveBeenCalledOnce();
    }),
  );

  it.effect("blocks the upload cycle's cleanup after grant revocation", () =>
    Effect.gen(function* () {
      state.grantedEnvironments.add("secondary");
      const transferStarted = Promise.withResolvers<void>();
      const cycle = yield* Effect.forkChild(
        runAttachmentUploadCycle({
          registry,
          ...attachmentEnvironment,
          environmentId,
          upload: { name: "image.png", mimeType: "image/png", sizeBytes: 1 },
          resolveUploadUrl: () => "https://example.test/upload",
          transport: () =>
            Effect.callback<void>(() => {
              state.grantedEnvironments.delete("secondary");
              transferStarted.resolve();
            }),
        }),
      );
      yield* Effect.promise(() => transferStarted.promise);
      // Interrupting deletes the fresh mint, which the revoked grant must refuse.
      yield* Fiber.interrupt(cycle);
      expect(state.create).toHaveBeenCalledOnce();
      expect(state.remove).not.toHaveBeenCalled();
    }),
  );
});
