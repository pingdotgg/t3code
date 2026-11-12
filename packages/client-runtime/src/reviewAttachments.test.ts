import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestUploadAttachmentInput,
  type PullRequestUploadAttachmentResult,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  publishReviewAttachment,
  reviewAttachmentMarkdown,
  reviewAttachmentMimeType,
} from "./reviewAttachments.ts";
import type { AtomCommand } from "./state/runtime.ts";

describe("review attachments", () => {
  it("creates safe portable markdown for image and hosted file links", () => {
    expect(
      reviewAttachmentMarkdown({ url: "https://example.com/screen.png", name: "[screen]" }),
    ).toBe("![ screen ](<https://example.com/screen.png>)");
    expect(reviewAttachmentMarkdown({ url: "https://example.com/recording.mp4" })).toBe(
      "[Attachment](<https://example.com/recording.mp4>)",
    );
    expect(() => reviewAttachmentMarkdown({ url: "javascript:alert(1)" })).toThrow("HTTP");
    expect(reviewAttachmentMimeType("application/octet-stream", "Screenshot.PNG")).toBe(
      "image/png",
    );
    expect(reviewAttachmentMimeType("application/pdf", "notes.pdf")).toBeNull();
  });

  const fixture = () => {
    const registry = AtomRegistry.make();
    const calls: string[] = [];
    const createUploadUrl: AtomCommand<
      { environmentId: EnvironmentId; input: AttachmentCreateUploadUrlInput },
      AttachmentCreateUploadUrlResult,
      never
    > = {
      label: "mint",
      run: async (_, input) => {
        calls.push(`mint:${input.environmentId}`);
        return AsyncResult.success({
          attachmentId: "pending-image",
          relativeUrl: "/upload",
          expiresAt: 1,
        });
      },
    };
    const remove: AtomCommand<
      { environmentId: EnvironmentId; input: AttachmentDeleteInput },
      void,
      never
    > = {
      label: "remove",
      run: async (_, input) => {
        calls.push(`remove:${input.input.attachmentId}`);
        return AsyncResult.success(undefined);
      },
    };
    const publish: AtomCommand<
      { environmentId: EnvironmentId; input: PullRequestUploadAttachmentInput },
      PullRequestUploadAttachmentResult,
      Error
    > = {
      label: "publish",
      run: async (_, input) => {
        calls.push(`publish:${input.environmentId}:${input.input.attachmentId}`);
        return AsyncResult.success({ url: "https://github.com/user-attachments/assets/image" });
      },
    };
    return {
      calls,
      input: {
        registry,
        createUploadUrl,
        remove,
        publish,
        environmentId: EnvironmentId.make("remote"),
        reference: { projectId: ProjectId.make("project"), repository: "acme/app", number: 1 },
        upload: { type: "file" as const, name: "screen.png", mimeType: "image/png", sizeBytes: 3 },
        resolveUploadUrl: (path: string) => `https://remote.test${path}`,
        transport: (url: string) => {
          calls.push(`transfer:${url}`);
          return { done: Promise.resolve(), abort: () => {} };
        },
      },
    };
  };
  it("transfers bytes and publishes from the same remote environment before returning a link", async () => {
    const { input, calls } = fixture();
    expect(await publishReviewAttachment(input)).toBe(
      "![screen.png](<https://github.com/user-attachments/assets/image>)",
    );
    expect(calls).toEqual([
      "mint:remote",
      "transfer:https://remote.test/upload",
      "publish:remote:pending-image",
      "remove:pending-image",
    ]);
    input.registry.dispose();
  });
  it("releases temporary bytes when publishing fails and never claims a successful attachment", async () => {
    const { input, calls } = fixture();
    input.publish = {
      ...input.publish,
      run: async () => AsyncResult.failure(Cause.fail(new Error("Host refused upload"))),
    };
    await expect(publishReviewAttachment(input)).rejects.toThrow("Host refused upload");
    expect(calls.at(-1)).toBe("remove:pending-image");
    input.registry.dispose();
  });
  it("does not publish bytes after a failed transfer", async () => {
    const { input, calls } = fixture();
    await expect(
      publishReviewAttachment({
        ...input,
        transport: () => ({ done: Promise.reject(new Error("Disconnected")), abort: () => {} }),
      }),
    ).rejects.toThrow("Disconnected");
    expect(calls).toEqual(["mint:remote", "remove:pending-image"]);
    input.registry.dispose();
  });
  it("releases the pending upload when its draft is closed before publication", async () => {
    const { input, calls } = fixture();
    await expect(publishReviewAttachment({ ...input, isCancelled: () => true })).rejects.toThrow(
      "Upload cancelled",
    );
    expect(calls).toEqual([
      "mint:remote",
      "transfer:https://remote.test/upload",
      "remove:pending-image",
    ]);
    input.registry.dispose();
  });
});
