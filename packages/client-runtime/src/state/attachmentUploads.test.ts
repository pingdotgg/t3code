import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import {
  attachmentUploadError,
  createAttachmentUploadRegistry,
  type AttachmentUploadError,
  type AttachmentUploadStatus,
} from "./attachmentUploads.ts";

interface UploadRequest {
  readonly environmentId: EnvironmentId;
  readonly attachment: { readonly id: string; readonly fileUri: string };
}

const environmentId = EnvironmentId.make("environment-1");
const uploadKey = (environment: EnvironmentId, id: string) => `${environment}:${id}`;

function request(id: string, environment = environmentId): UploadRequest {
  return { environmentId: environment, attachment: { id, fileUri: `file:///documents/${id}.pdf` } };
}

/** The registry over a promise-based transfer, as each client wires its own. */
function createQueue(options: {
  readonly upload: (
    request: UploadRequest,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<string>;
  readonly onUploaded?: (
    request: UploadRequest,
    uploadedId: string,
  ) => Effect.Effect<void, AttachmentUploadError>;
  readonly onChange: (statuses: Readonly<Record<string, AttachmentUploadStatus>>) => void;
  readonly concurrencyPerEnvironment?: number;
}) {
  return createAttachmentUploadRegistry<UploadRequest>({
    key: (candidate) => uploadKey(candidate.environmentId, candidate.attachment.id),
    environmentId: (candidate) => candidate.environmentId,
    concurrencyPerEnvironment: options.concurrencyPerEnvironment ?? 3,
    upload: (candidate, report) =>
      Effect.tryPromise({
        try: (signal) => options.upload(candidate, signal, report),
        catch: attachmentUploadError,
      }),
    ...(options.onUploaded ? { onUploaded: options.onUploaded } : {}),
    onChange: options.onChange,
  });
}

describe("attachment upload registry", () => {
  it("bounds concurrency, deduplicates updates, and drains all attachments", async () => {
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const fourthStarted = Promise.withResolvers<void>();
    const firstThreeStarted = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    const upload = vi.fn(async (input: UploadRequest) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const gate = Promise.withResolvers<string>();
      gates.set(input.attachment.id, gate);
      if (gates.size === 3) firstThreeStarted.resolve();
      if (gates.size === 4) fourthStarted.resolve();
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    });
    const queue = createQueue({ upload, onChange: () => {} });
    const requests = [request("one"), request("two"), request("three"), request("four")];
    queue.sync(requests);
    queue.sync(requests);
    await firstThreeStarted.promise;
    expect(upload).toHaveBeenCalledTimes(3);
    gates.get("one")!.resolve("uploaded");
    await fourthStarted.promise;
    for (const gate of gates.values()) gate.resolve("uploaded");
    await queue.settled();
    queue.sync(requests);
    await queue.settled();
    expect(maximum).toBe(3);
    expect(upload).toHaveBeenCalledTimes(4);
    queue.dispose();
  });

  it("cancels on disconnect and resumes from the same local draft on reconnect", async () => {
    const started = Promise.withResolvers<void>();
    let states: Readonly<Record<string, AttachmentUploadStatus>> = {};
    let signal: AbortSignal | undefined;
    const upload = vi.fn(async (_request: UploadRequest, currentSignal: AbortSignal) => {
      signal = currentSignal;
      started.resolve();
      return new Promise<string>((resolve) =>
        currentSignal.addEventListener("abort", () => resolve("aborted"), { once: true }),
      );
    });
    const queue = createQueue({
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
    upload.mockResolvedValueOnce("uploaded");
    queue.sync([local]);
    await queue.settled();
    expect(upload.mock.calls[1]?.[0]).toBe(local);
    expect(states[uploadKey(environmentId, local.attachment.id)]).toEqual({
      status: "ready",
    });
    expect(local.attachment).toMatchObject({ fileUri: "file:///documents/offline-draft.pdf" });
    queue.dispose();
  });

  it("retries a failed attachment when the worker restores requests after reconnect", async () => {
    let states: Readonly<Record<string, AttachmentUploadStatus>> = {};
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue("uploaded");
    const queue = createQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    const local = request("failed-upload");
    const key = uploadKey(environmentId, local.attachment.id);
    queue.sync([local]);
    await queue.settled();
    expect(states[key]?.status).toBe("failed");
    queue.sync([local]);
    await queue.settled();
    expect(upload).toHaveBeenCalledTimes(1);
    queue.sync([]);
    queue.sync([local]);
    await queue.settled();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(states[key]?.status).toBe("ready");
    queue.dispose();
  });

  it("ignores a late completion after removal or environment switch", async () => {
    const gate = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    let states: Readonly<Record<string, AttachmentUploadStatus>> = {};
    const upload = vi.fn(async () => {
      started.resolve();
      return gate.promise;
    });
    const queue = createQueue({
      upload,
      onChange: (next) => {
        states = next;
      },
    });
    queue.sync([request("photo")]);
    await started.promise;
    upload.mockResolvedValueOnce("uploaded");
    const other = EnvironmentId.make("environment-2");
    queue.sync([request("photo", other)]);
    gate.resolve("uploaded");
    await queue.settled();
    expect(states).toEqual({ [uploadKey(other, "photo")]: { status: "ready" } });
    queue.sync([]);
    expect(states).toEqual({});
    queue.dispose();
  });

  it("keeps failures stable until retry and reports bounded progress", async () => {
    let states: Readonly<Record<string, AttachmentUploadStatus>> = {};
    const progress: number[] = [];
    const upload = vi.fn(
      async (
        _request: UploadRequest,
        _signal: AbortSignal,
        report: (value: number) => void,
      ): Promise<string> => {
        report(0.12);
        report(0.13);
        report(1.1);
        throw new Error("Server unavailable");
      },
    );
    const queue = createQueue({
      upload,
      onChange: (next) => {
        states = next;
        const state = next[uploadKey(environmentId, "file")];
        if (state?.status === "uploading") progress.push(state.progress);
      },
    });
    queue.sync([request("file")]);
    await queue.settled();
    queue.sync([request("file")]);
    expect(upload).toHaveBeenCalledOnce();
    expect(states[uploadKey(environmentId, "file")]).toEqual({
      status: "failed",
      reason: "Server unavailable",
    });
    expect(progress).toEqual([0, 0.1, 1]);
    upload.mockImplementationOnce(async (_request, _signal, report) => {
      report(0.5);
      return "uploaded";
    });
    queue.retry(uploadKey(environmentId, "file"));
    expect(states[uploadKey(environmentId, "file")]).toEqual({
      status: "uploading",
      progress: 0.5,
      retrying: true,
    });
    await queue.settled();
    expect(states[uploadKey(environmentId, "file")]).toEqual({ status: "ready" });
    queue.dispose();
  });

  it("does not mark a later upload as retrying when no synced holder could retry", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("Server unavailable"))
      .mockResolvedValue("uploaded");
    const queue = createQueue({ upload, onChange: () => {} });
    try {
      const local = request("file");
      const key = uploadKey(environmentId, local.attachment.id);
      const release = queue.hold(local);
      await queue.settled();
      expect(queue.status(key)?.status).toBe("failed");

      queue.retry(key);
      expect(upload).toHaveBeenCalledOnce();
      release();
      expect(queue.status(key)).toBeUndefined();

      queue.sync([local]);
      expect(queue.status(key)).toEqual({ status: "uploading", progress: 0 });
      await queue.settled();
    } finally {
      queue.dispose();
    }
  });

  it.effect("joins a send to the running upload instead of uploading again", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<string>();
      const started = Promise.withResolvers<void>();
      const uploaded = vi.fn();
      const upload = vi.fn(async () => {
        started.resolve();
        return gate.promise;
      });
      let states: Readonly<Record<string, AttachmentUploadStatus>> = {};
      const queue = createQueue({
        upload,
        onUploaded: uploaded,
        onChange: (next) => {
          states = next;
        },
      });
      const local = request("video");
      queue.sync([local]);
      yield* Effect.promise(() => started.promise);
      // Sending hands the attachment from the draft to the outbox, which uploads it too.
      const sent = yield* Effect.forkChild(queue.upload(local), { startImmediately: true });
      queue.sync([]);
      gate.resolve("uploaded-1");
      expect(yield* Fiber.join(sent)).toBe("uploaded-1");
      expect(upload).toHaveBeenCalledOnce();
      expect(uploaded).toHaveBeenCalledExactlyOnceWith(local, "uploaded-1");
      yield* Effect.promise(() => queue.settled());
      expect(states).toEqual({});
      queue.dispose();
    }),
  );
  it.effect("restarts a failed upload when a send joins it instead of rejoining the failure", () =>
    Effect.gen(function* () {
      const replacement = Promise.withResolvers<string>();
      const upload = vi
        .fn()
        .mockRejectedValueOnce(new Error("Server unavailable"))
        .mockImplementationOnce(() => replacement.promise);
      const queue = createQueue({ upload, onChange: () => {} });
      const local = request("photo");
      const key = uploadKey(environmentId, local.attachment.id);
      const release = queue.hold(local);
      yield* Effect.promise(() => queue.settled());
      expect(queue.status(key)?.status).toBe("failed");

      const sent = yield* Effect.forkChild(queue.upload(local), { startImmediately: true });
      expect(queue.status(key)).toEqual({ status: "uploading", progress: 0, retrying: true });
      replacement.resolve("uploaded-2");
      expect(yield* Fiber.join(sent)).toBe("uploaded-2");
      expect(upload).toHaveBeenCalledTimes(2);
      release();
      queue.dispose();
    }),
  );

  it.effect("keeps a replacement upload's status when the upload it replaced is released", () =>
    Effect.gen(function* () {
      const replacement = Promise.withResolvers<string>();
      const upload = vi
        .fn()
        .mockRejectedValueOnce(new Error("Server unavailable"))
        .mockImplementationOnce(() => replacement.promise);
      let statuses: Readonly<Record<string, AttachmentUploadStatus>> = {};
      const queue = createQueue({
        upload,
        onChange: (next) => {
          statuses = next;
        },
      });
      const local = request("photo");
      const releaseFailed = queue.hold(local);
      yield* Effect.promise(() => queue.settled());
      queue.invalidate(uploadKey(environmentId, "photo"));
      const releaseReplacement = queue.hold(local);
      releaseFailed();
      expect(statuses[uploadKey(environmentId, "photo")]).toEqual({
        status: "uploading",
        progress: 0,
      });
      replacement.resolve("uploaded-2");
      yield* Effect.promise(() => queue.settled());
      expect(statuses[uploadKey(environmentId, "photo")]).toEqual({ status: "ready" });
      releaseReplacement();
      queue.dispose();
    }),
  );
});
