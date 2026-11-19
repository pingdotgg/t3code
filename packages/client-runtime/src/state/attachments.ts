import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  WS_METHODS,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  awaitAtomResult,
  observeAtomCommand,
  type AtomCommand,
} from "./runtime.ts";

export function createAttachmentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    createUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:attachments:create-upload-url",
      tag: WS_METHODS.attachmentsCreateUploadUrl,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:attachments:delete",
      tag: WS_METHODS.attachmentsDelete,
    }),
  };
}

/**
 * Pending uploads expire, so this is the signal to upload the bytes again rather than retry the
 * lookup. A structural `_tag` check rather than a schema check: the squashed cause of a failed
 * RPC is not guaranteed to be a decoded error class instance, only a tagged value.
 */
export function isAssetAttachmentNotFoundFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AssetAttachmentNotFoundError"
  );
}

export type PersistedAttachmentVerification =
  | { readonly status: "verified" }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly error: unknown };

export const verifyPersistedAttachmentUpload = Effect.fn("Attachments.verifyPersistedUpload")(
  function* <A, E>(input: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly createAssetUrl: (query: {
      readonly environmentId: EnvironmentId;
      readonly input: {
        readonly resource: { readonly _tag: "attachment"; readonly attachmentId: string };
      };
    }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>;
    readonly environmentId: EnvironmentId;
    readonly attachmentId: string;
  }) {
    return yield* awaitAtomResult(
      input.registry,
      input.createAssetUrl({
        environmentId: input.environmentId,
        input: { resource: { _tag: "attachment", attachmentId: input.attachmentId } },
      }),
      // `refresh` forces a server round trip: the asset URL query atom caches
      // results (SWR), so a retry right after a transient failure would
      // otherwise re-observe the cached failure and never ask the server.
      { refresh: true },
    ).pipe(
      Effect.matchCause({
        onSuccess: (): PersistedAttachmentVerification => ({ status: "verified" }),
        onFailure: (cause): PersistedAttachmentVerification => {
          const error = Cause.squash(cause);
          return isAssetAttachmentNotFoundFailure(error)
            ? { status: "missing" }
            : { status: "failed", error };
        },
      }),
    );
  },
);

type AttachmentCreateUploadUrlCommand<E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  E
>;

type AttachmentRemoveCommand<E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  E
>;

export function deletePendingAttachmentUpload<E>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly remove: AttachmentRemoveCommand<E>;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}) {
  return Effect.suspend(() =>
    input.remove.run(input.registry, {
      environmentId: input.environmentId,
      input: { attachmentId: input.attachmentId },
    }),
  ).pipe(Effect.ignoreCause);
}

export type AttachmentUploadCycleResult =
  | { readonly status: "uploaded"; readonly attachmentId: string }
  | {
      readonly status: "failed";
      readonly step: "mint" | "resolve-url" | "transfer";
      readonly attachmentId: string | null;
      readonly error: unknown;
    };

/**
 * Mints an upload slot and sends the bytes. A failure keeps the minted id in the result so the
 * caller decides between retry and release. Interrupting the cycle aborts the transfer and
 * deletes the fresh mint, including when the interruption arrives while minting.
 */
export function runAttachmentUploadCycle<E, RE, TE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly createUploadUrl: AttachmentCreateUploadUrlCommand<E>;
  readonly remove: AttachmentRemoveCommand<RE>;
  readonly environmentId: EnvironmentId;
  readonly upload: AttachmentCreateUploadUrlInput;
  readonly resolveUploadUrl: (relativeUrl: string) => string | null;
  /** Sends the bytes; interrupting it aborts the transfer. */
  readonly transport: (url: string) => Effect.Effect<void, TE>;
}): Effect.Effect<AttachmentUploadCycleResult> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const minted = yield* observeAtomCommand(
        input.registry,
        input.createUploadUrl,
        { environmentId: input.environmentId, input: input.upload },
        { reportFailure: false },
      );
      if (minted._tag !== "Success") {
        return {
          status: "failed",
          step: "mint",
          attachmentId: null,
          error: Cause.squash(minted.cause),
        } as const;
      }
      const attachmentId = minted.value.attachmentId;
      return yield* restore(
        Effect.suspend(() => {
          const url = input.resolveUploadUrl(minted.value.relativeUrl);
          if (!url) {
            return Effect.succeed<AttachmentUploadCycleResult>({
              status: "failed",
              step: "resolve-url",
              attachmentId,
              error: new Error("The environment is not connected."),
            });
          }
          return input.transport(url).pipe(
            Effect.as<AttachmentUploadCycleResult>({ status: "uploaded", attachmentId }),
            Effect.catch((error) =>
              Effect.succeed<AttachmentUploadCycleResult>({
                status: "failed",
                step: "transfer",
                attachmentId,
                error,
              }),
            ),
          );
        }),
      ).pipe(
        Effect.onInterrupt(() =>
          deletePendingAttachmentUpload({ ...input, attachmentId }).pipe(
            Effect.forkDetach({ startImmediately: true }),
            Effect.asVoid,
          ),
        ),
      );
    }),
  ).pipe(Effect.withSpan("Attachments.runUploadCycle"));
}

/**
 * The contract caps what a turn may reference, so a larger advertised value must not admit
 * files the send would then refuse.
 */
export function clampFileAttachmentUploadBytes(advertisedMaxUploadBytes: number): number {
  return Math.min(advertisedMaxUploadBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
}

export function formatAttachmentSize(
  sizeBytes: number,
  resolve: MFunctionType = mFallback,
): string {
  const kilobytes = Math.max(1, Math.ceil(sizeBytes / 1024));
  // Pick the unit after rounding, so 1023.5 KB reads "1.0 MB", not "1024 KB".
  return kilobytes >= 1024
    ? resolve(msg("{size} MB", { size: (sizeBytes / (1024 * 1024)).toFixed(1) }))
    : resolve(msg("{size} KB", { size: kilobytes }));
}

export function fileAttachmentTooLargeMessage(
  name: string,
  maxUploadBytes: number,
  resolve: MFunctionType = mFallback,
): string {
  const size =
    maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
      ? resolve(msg("{count} MB", { count: maxUploadBytes / (1024 * 1024) }))
      : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
        ? resolve(msg("{count} KB", { count: maxUploadBytes / 1024 }))
        : resolve(
            msg("{count, plural, one {{count} byte} other {{count} bytes}}", {
              count: maxUploadBytes,
            }),
          );
  return resolve(msg("''{name}'' exceeds the {size} attachment limit.", { name, size }));
}
