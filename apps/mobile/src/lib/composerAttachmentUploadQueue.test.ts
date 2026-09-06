import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadRequest,
  type ComposerAttachmentUploadState,
} from "./composerAttachmentUploadQueue";

const environmentId = EnvironmentId.make("environment-1");
function request(id: string, environment = environmentId): ComposerAttachmentUploadRequest {
  return {
    environmentId: environment,
    attachment: {
      id,
      type: "file",
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/${id}.pdf`,
    },
  };
}

describe("composer attachment upload queue", () => {
  it("bounds concurrency, deduplicates updates, and drains all attachments", async () => {
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
    const fourthStarted = Promise.withResolvers<void>();
    const firstThreeStarted = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    const upload = vi.fn(async (input: ComposerAttachmentUploadRequest) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const gate = Promise.withResolvers<boolean>();
      gates.set(input.attachment.id, gate);
      if (gates.size === 3) firstThreeStarted.resolve();
      if (gates.size === 4) fourthStarted.resolve();
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    });
    const queue = createComposerAttachmentUploadQueue({ upload, onChange: () => {} });
    const requests = [request("one"), request("two"), request("three"), request("four")];
    queue.sync(requests);
    queue.sync(requests);
    await firstThreeStarted.promise;
    expect(upload).toHaveBeenCalledTimes(3);
    gates.get("one")!.resolve(true);
    await fourthStarted.promise;
    for (const gate of gates.values()) gate.resolve(true);
    await queue.settled();
    queue.sync(requests);
    await queue.settled();
    expect(maximum).toBe(3);
    expect(upload).toHaveBeenCalledTimes(4);
    queue.dispose();
  });

  it("cancels on disconnect and resumes from the same local draft on reconnect", async () => {
    const started = Promise.withResolvers<void>();
    let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
    let signal: AbortSignal | undefined;
    const upload = vi.fn(
      async (_request: ComposerAttachmentUploadRequest, currentSignal: AbortSignal) => {
        signal = currentSignal;
        started.resolve();
        return new Promise<boolean>((resolve) =>
          currentSignal.addEventListener("abort", () => resolve(false), { once: true }),
        );
      },
    );
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    const local = request("offline-draft");
    queue.sync([local]);
    await started.promise;
    queue.sync([]);
    await queue.settled();
    expect(signal?.aborted).toBe(true);
    expect(states).toEqual({});
    upload.mockResolvedValueOnce(true);
    queue.sync([local]);
    await queue.settled();
    expect(upload.mock.calls[1]?.[0]).toBe(local);
    expect(states[composerAttachmentUploadKey(environmentId, local.attachment.id)]).toEqual({
      status: "ready",
    });
    expect(local.attachment).toMatchObject({ fileUri: "file:///documents/offline-draft.pdf" });
    queue.dispose();
  });

  it("ignores a late completion after removal or environment switch", async () => {
    const gate = Promise.withResolvers<boolean>();
    const started = Promise.withResolvers<void>();
    let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
    const upload = vi.fn(async () => {
      started.resolve();
      return gate.promise;
    });
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    queue.sync([request("photo")]);
    await started.promise;
    upload.mockResolvedValueOnce(true);
    const other = EnvironmentId.make("environment-2");
    queue.sync([request("photo", other)]);
    gate.resolve(true);
    await queue.settled();
    expect(states).toEqual({ [composerAttachmentUploadKey(other, "photo")]: { status: "ready" } });
    queue.sync([]);
    expect(states).toEqual({});
    queue.dispose();
  });

  it("restarts a re-added attachment after its aborted transfer finishes settling", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstSettled = Promise.withResolvers<boolean>();
    const secondStarted = Promise.withResolvers<void>();
    const secondSettled = Promise.withResolvers<boolean>();
    let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
    let firstSignal: AbortSignal | undefined;
    const upload = vi.fn(async (_request: ComposerAttachmentUploadRequest, signal: AbortSignal) => {
      if (!firstSignal) {
        firstSignal = signal;
        firstStarted.resolve();
        return firstSettled.promise;
      }
      secondStarted.resolve();
      return secondSettled.promise;
    });
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    const local = request("re-added");
    queue.sync([local]);
    await firstStarted.promise;
    queue.sync([]);
    queue.sync([local]);
    expect(firstSignal?.aborted).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    firstSettled.resolve(false);
    await secondStarted.promise;
    expect(upload).toHaveBeenCalledTimes(2);
    secondSettled.resolve(true);
    await queue.settled();
    expect(states[composerAttachmentUploadKey(environmentId, local.attachment.id)]).toEqual({
      status: "ready",
    });
    queue.dispose();
  });

  it("keeps failures stable until retry and reports bounded progress", async () => {
    let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
    const progress: number[] = [];
    const upload = vi.fn(
      async (
        _request: ComposerAttachmentUploadRequest,
        _signal: AbortSignal,
        report: (value: number) => void,
      ): Promise<boolean> => {
        report(0.12);
        report(0.13);
        report(1.1);
        throw new Error("Server unavailable");
      },
    );
    const queue = createComposerAttachmentUploadQueue({
      upload,
      onChange: (next) => {
        states = next;
        const state = next[composerAttachmentUploadKey(environmentId, "file")];
        if (state?.status === "uploading") progress.push(state.progress);
      },
    });
    queue.sync([request("file")]);
    await queue.settled();
    queue.sync([request("file")]);
    expect(upload).toHaveBeenCalledOnce();
    expect(states[composerAttachmentUploadKey(environmentId, "file")]).toEqual({
      status: "failed",
      reason: "Server unavailable",
    });
    expect(progress).toEqual([0, 0.1, 1]);
    upload.mockImplementationOnce(async () => true);
    queue.retry(environmentId, "file");
    await queue.settled();
    expect(states[composerAttachmentUploadKey(environmentId, "file")]).toEqual({ status: "ready" });
    queue.dispose();
  });

  it("does not spin when an upload's draft was abandoned before persistence", async () => {
    const upload = vi.fn(async () => false);
    const queue = createComposerAttachmentUploadQueue({ upload, onChange: () => {} });
    queue.sync([request("discarded")]);
    await queue.settled();
    expect(upload).toHaveBeenCalledOnce();
    queue.dispose();
  });
});

describe("draft upload scope and offline submission", () => {
  it("resolves thread, new-task, and queued-task drafts without crossing environments", () => {
    expect(composerDraftEnvironmentId("environment-1:thread", [])).toBe(environmentId);
    expect(composerDraftEnvironmentId("new-task:environment-1:project", [])).toBe(environmentId);
    expect(
      composerDraftEnvironmentId("pending-task:message", [{ messageId: "message", environmentId }]),
    ).toBe(environmentId);
    expect(composerDraftEnvironmentId("pending-task:missing", [])).toBeNull();
    const colonEnvironment = EnvironmentId.make("a:vcs-status:b");
    expect(composerDraftEnvironmentId(`${colonEnvironment}:thread`, [])).toBe(colonEnvironment);
    expect(composerDraftEnvironmentId(`new-task:${colonEnvironment}:project`, [])).toBe(
      colonEnvironment,
    );
  });

  it("reads an id-keyed new-task draft's environment from its project stamp", () => {
    const stamped = {
      project: {
        environmentId,
        projectId: "project" as never,
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    };
    expect(composerDraftEnvironmentId("new-task:abc123-def456", [], stamped)).toBe(environmentId);
    // An id-keyed draft that lost its stamp belongs to nobody: uploads must
    // not start and sign-out must not sweep it into some other environment.
    expect(composerDraftEnvironmentId("new-task:abc123-def456", [])).toBeNull();
    // The stamp wins over a legacy-looking key when both are present.
    expect(composerDraftEnvironmentId("new-task:environment-2:project", [], stamped)).toBe(
      environmentId,
    );
  });

  it("only a failed upload blocks sending; an in-flight one queues instead", () => {
    const key = composerAttachmentUploadKey(environmentId, "file");
    const input = {
      environmentId,
      attachments: [request("file").attachment],
      connected: true,
      serverConfig: {
        environment: {
          capabilities: { attachmentUploads: true, fileAttachments: { maxUploadBytes: 1024 } },
        },
      },
      states: {},
    };
    // Not started yet and mid-transfer both let the send through as a queued
    // message; the outbox drain finishes (or redoes) the upload.
    expect(composerAttachmentUploadBlockReason(input)).toBeNull();
    expect(composerAttachmentsStillUploading(input)).toBe(true);
    expect(
      composerAttachmentsStillUploading({
        ...input,
        states: { [key]: { status: "uploading", progress: 0.6 } },
      }),
    ).toBe(true);
    expect(composerAttachmentUploadBlockReason({ ...input, connected: false })).toBeNull();
    expect(
      composerAttachmentUploadBlockReason({
        ...input,
        states: { [key]: { status: "failed", reason: "Offline" } },
      }),
    ).toBe("Retry or remove the failed attachment");
    expect(
      composerAttachmentsStillUploading({
        ...input,
        states: { [key]: { status: "failed", reason: "Offline" } },
      }),
    ).toBe(false);
    expect(
      composerAttachmentUploadBlockReason({ ...input, states: { [key]: { status: "ready" } } }),
    ).toBeNull();
    expect(
      composerAttachmentsStillUploading({ ...input, states: { [key]: { status: "ready" } } }),
    ).toBe(false);
    // Attachments the environment cannot accept never count as uploading.
    expect(composerAttachmentsStillUploading({ ...input, serverConfig: null })).toBe(false);
  });
});
