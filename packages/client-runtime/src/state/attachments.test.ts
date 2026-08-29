import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { AtomCommand } from "./runtime.ts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
// The cycle threads the registry through to the commands untouched, so the
// fakes below can ignore it.
const registry = {} as AtomRegistry.AtomRegistry;

type CreateUploadUrlCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;

type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function makeCreateUploadUrl(attachmentId: string): CreateUploadUrlCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success<AttachmentCreateUploadUrlResult, never>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: async (_registry, input) => {
    removeCalls.push(input.input.attachmentId);
    return AsyncResult.success(undefined);
  },
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it("mints, transfers, and reports the attachment id", async () => {
    const transferred: string[] = [];
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-1"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: (relativeUrl) => `https://environment.test${relativeUrl}`,
      transport: (url) => {
        transferred.push(url);
        return { done: Promise.resolve(), abort: () => {} };
      },
    });

    expect(result).toEqual({ status: "uploaded", attachmentId: "pending-1" });
    expect(transferred).toEqual(["https://environment.test/api/attachments/upload/pending-1"]);
  });

  it("deletes the fresh mint when the caller cancels at onMinted", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });

    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removeCalls).toEqual(["pending-cancelled"]);
  });

  it("keeps the minted id on transfer failure so the caller can retry or release", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-failed"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => ({
        done: Promise.reject(new Error("Upload rejected (413)")),
        abort: () => {},
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-failed",
    });
    expect(removeCalls).toEqual([]);
  });
});

describe("verifyPersistedAttachmentUpload", () => {
  it("hits the server on every verification instead of reusing a cached failure", async () => {
    // Mirrors the app's asset URL query atom: SWR-cached with a long stale
    // window and kept alive across calls. Without a forced refresh, the
    // second verification would read the cached failure and never retry.
    let lookups = 0;
    const assetUrlAtom = Atom.make(
      // Async like the real RPC, so the first read is still in flight when
      // the query decides whether a refresh is needed.
      Effect.promise(() => Promise.resolve()).pipe(
        Effect.flatMap(() => {
          lookups += 1;
          return lookups === 1
            ? Effect.fail({ _tag: "TransportError" } as const)
            : Effect.succeed({ url: "/api/assets/pending-1" });
        }),
      ),
    ).pipe(Atom.swr({ staleTime: 60_000 }), Atom.keepAlive);
    const liveRegistry = AtomRegistry.make();

    const verify = () =>
      verifyPersistedAttachmentUpload({
        registry: liveRegistry,
        createAssetUrl: () => assetUrlAtom,
        environmentId,
        attachmentId: "pending-1",
      });

    const first = await verify();
    expect(first).toMatchObject({ status: "failed" });

    const second = await verify();
    expect(second).toEqual({ status: "verified" });
    expect(lookups).toBe(2);
  });
});

describe("file attachment limits", () => {
  it("clamps the advertised limit to the turn contract cap", () => {
    expect(clampFileAttachmentUploadBytes(1024)).toBe(1024);
    expect(clampFileAttachmentUploadBytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2)).toBe(
      PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
  });

  it("formats attachment row sizes", () => {
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatAttachmentSize(1)).toBe("1 KB");
  });

  it("formats small upload limits without rounding them to zero MB", () => {
    expect(fileAttachmentTooLargeMessage("tiny.txt", 1)).toBe(
      "'tiny.txt' exceeds the 1 byte attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("small.txt", 1024)).toBe(
      "'small.txt' exceeds the 1 KB attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("exact.txt", 1025)).toBe(
      "'exact.txt' exceeds the 1025 bytes attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("medium.zip", 512 * 1024)).toBe(
      "'medium.zip' exceeds the 512 KB attachment limit.",
    );
  });

  it("keeps whole-MB upload limits for standard server caps", () => {
    expect(fileAttachmentTooLargeMessage("one.bin", 1024 * 1024)).toBe(
      "'one.bin' exceeds the 1 MB attachment limit.",
    );
    expect(fileAttachmentTooLargeMessage("big.zip", 50 * 1024 * 1024)).toBe(
      "'big.zip' exceeds the 50 MB attachment limit.",
    );
  });
});
