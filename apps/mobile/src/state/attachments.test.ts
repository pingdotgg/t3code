import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  state.create.mockReset().mockResolvedValue(
    AsyncResult.success({
      attachmentId: "pending",
      relativeUrl: "/upload",
      expiresAt: 1,
    }),
  );
  state.remove.mockReset().mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachment mutation grants", () => {
  it("uses the attachment environment for both mint and deletion", async () => {
    const mintResult = await attachmentEnvironment.createUploadUrl.run(registry, {
      environmentId,
      input: { name: "image.png", mimeType: "image/png", sizeBytes: 1 },
    });
    const removeResult = await attachmentEnvironment.remove.run(registry, {
      environmentId,
      input: { attachmentId: "pending" },
    });
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
      (
        await attachmentEnvironment.remove.run(registry, {
          environmentId,
          input: { attachmentId: "pending" },
        })
      )._tag,
    ).toBe("Success");
    expect(state.remove).toHaveBeenCalledOnce();
  });

  it("blocks the upload cycle's asynchronous cleanup after grant revocation", async () => {
    state.grantedEnvironments.add("secondary");
    const transport = vi.fn();
    const result = await runAttachmentUploadCycle({
      registry,
      ...attachmentEnvironment,
      environmentId,
      upload: { name: "image.png", mimeType: "image/png", sizeBytes: 1 },
      resolveUploadUrl: () => "https://example.test/upload",
      transport,
      onMinted: () => {
        state.grantedEnvironments.delete("secondary");
        return "cancel";
      },
    });
    expect(result.status).toBe("cancelled");
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.remove).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
