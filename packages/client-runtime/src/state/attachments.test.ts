import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";
import {
  formatAttachmentSize,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
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
    run: () =>
      Effect.succeed<AttachmentCreateUploadUrlResult>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: (_registry, input) =>
    Effect.sync(() => {
      removeCalls.push(input.input.attachmentId);
    }),
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it.effect("aborts the transfer and deletes the fresh mint when interrupted", () =>
    Effect.gen(function* () {
      removeCalls.length = 0;
      const transferStarted = Promise.withResolvers<void>();
      let aborted = false;
      const cycle = yield* Effect.forkChild(
        runAttachmentUploadCycle({
          registry,
          createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
          remove,
          environmentId,
          upload: uploadInput,
          resolveUploadUrl: () => "https://environment.test/upload",
          transport: () =>
            Effect.callback<void>(() => {
              transferStarted.resolve();
              return Effect.sync(() => {
                aborted = true;
              });
            }),
        }),
      );
      yield* Effect.promise(() => transferStarted.promise);
      yield* Fiber.interrupt(cycle);

      expect(aborted).toBe(true);
      expect(removeCalls).toEqual(["pending-cancelled"]);
    }),
  );

  it.effect("keeps the minted id on transfer failure so the caller can retry or release", () =>
    Effect.gen(function* () {
      removeCalls.length = 0;
      const result = yield* runAttachmentUploadCycle({
        registry,
        createUploadUrl: makeCreateUploadUrl("pending-failed"),
        remove,
        environmentId,
        upload: uploadInput,
        resolveUploadUrl: () => "https://environment.test/upload",
        transport: () => Effect.fail({ _tag: "UploadRejected", status: 413 } as const),
      });

      expect(result).toMatchObject({
        status: "failed",
        step: "transfer",
        attachmentId: "pending-failed",
      });
      expect(removeCalls).toEqual([]);
    }),
  );
});

describe("verifyPersistedAttachmentUpload", () => {
  it.effect("hits the server on every verification instead of reusing a cached failure", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const assetUrlAtom = Atom.make(
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

      const verify = verifyPersistedAttachmentUpload({
        registry: liveRegistry,
        createAssetUrl: () => assetUrlAtom,
        environmentId,
        attachmentId: "pending-1",
      });

      expect(yield* verify).toMatchObject({ status: "failed" });
      expect(yield* verify).toEqual({ status: "verified" });
      expect(lookups).toBe(2);
    }),
  );

  it.effect("stops the lookup when its caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const assetUrlAtom = Atom.make(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(released, undefined)),
        ),
      );
      const fiber = yield* Effect.forkChild(
        verifyPersistedAttachmentUpload({
          registry: AtomRegistry.make(),
          createAssetUrl: () => assetUrlAtom,
          environmentId,
          attachmentId: "pending-1",
        }),
      );

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(released);
    }),
  );
});

describe("formatAttachmentSize", () => {
  it.each([
    [1_047_552, "1023 KB"],
    [1_047_553, "1.0 MB"],
    [1_048_575, "1.0 MB"],
    [1_048_576, "1.0 MB"],
  ])("formats %d bytes as %s", (sizeBytes, label) => {
    expect(formatAttachmentSize(sizeBytes)).toBe(label);
  });
});
