import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  WS_METHODS,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
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

export async function verifyPersistedAttachmentUpload<A, E>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly createAssetUrl: (query: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly resource: { readonly _tag: "attachment"; readonly attachmentId: string };
    };
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): Promise<PersistedAttachmentVerification> {
  const result = await executeAtomQuery(
    input.registry,
    input.createAssetUrl({
      environmentId: input.environmentId,
      input: { resource: { _tag: "attachment", attachmentId: input.attachmentId } },
    }),
    // `refresh` forces a server round trip: the asset URL query atom caches
    // results (SWR), so a retry right after a transient failure would
    // otherwise re-observe the cached failure and never ask the server.
    { reportFailure: false, reportDefect: false, refresh: true },
  );
  if (result._tag === "Success") {
    return { status: "verified" };
  }
  const error = squashAtomCommandFailure(result);
  return isAssetAttachmentNotFoundFailure(error)
    ? { status: "missing" }
    : { status: "failed", error };
}

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
}): void {
  void runAtomCommand(
    input.registry,
    input.remove,
    { environmentId: input.environmentId, input: { attachmentId: input.attachmentId } },
    { reportFailure: false, reportDefect: false },
  );
}

export interface AttachmentByteUpload {
  readonly done: Promise<void>;
  readonly abort: () => void;
}

export type AttachmentUploadCycleResult =
  | { readonly status: "uploaded"; readonly attachmentId: string }
  | { readonly status: "cancelled"; readonly attachmentId: string | null }
  | {
      readonly status: "failed";
      readonly step: "mint" | "resolve-url" | "transfer";
      readonly attachmentId: string | null;
      readonly error: unknown;
    };

/**
 * The cycle never deletes the minted pending upload on failure: callers keep the returned
 * `attachmentId` and decide between retry and release. The one exception is `onMinted`
 * returning `"cancel"`, where the caller already abandoned the upload and the fresh mint is
 * deleted before returning.
 */
export async function runAttachmentUploadCycle<E, RE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly createUploadUrl: AttachmentCreateUploadUrlCommand<E>;
  readonly remove: AttachmentRemoveCommand<RE>;
  readonly environmentId: EnvironmentId;
  readonly upload: AttachmentCreateUploadUrlInput;
  readonly resolveUploadUrl: (relativeUrl: string) => string | null;
  readonly transport: (url: string) => AttachmentByteUpload;
  readonly onMinted?: (attachmentId: string) => "continue" | "cancel";
  readonly onTransferStart?: (abort: () => void) => void;
}): Promise<AttachmentUploadCycleResult> {
  const minted = await runAtomCommand(
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
      error: squashAtomCommandFailure(minted),
    };
  }
  const attachmentId = minted.value.attachmentId;
  if (input.onMinted?.(attachmentId) === "cancel") {
    deletePendingAttachmentUpload({
      registry: input.registry,
      remove: input.remove,
      environmentId: input.environmentId,
      attachmentId,
    });
    return { status: "cancelled", attachmentId };
  }

  const url = input.resolveUploadUrl(minted.value.relativeUrl);
  if (!url) {
    return {
      status: "failed",
      step: "resolve-url",
      attachmentId,
      error: new Error("The environment is not connected."),
    };
  }

  const transfer = input.transport(url);
  input.onTransferStart?.(transfer.abort);
  try {
    await transfer.done;
  } catch (error) {
    return { status: "failed", step: "transfer", attachmentId, error };
  }
  return { status: "uploaded", attachmentId };
}

/**
 * The contract caps what a turn may reference, so a larger advertised value must not admit
 * files the send would then refuse.
 */
export function clampFileAttachmentUploadBytes(advertisedMaxUploadBytes: number): number {
  return Math.min(advertisedMaxUploadBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
}

export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

export function fileAttachmentTooLargeMessage(name: string, maxUploadBytes: number): string {
  const maxUploadSize =
    maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
      ? `${maxUploadBytes / (1024 * 1024)} MB`
      : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
        ? `${maxUploadBytes / 1024} KB`
        : `${maxUploadBytes} ${maxUploadBytes === 1 ? "byte" : "bytes"}`;
  return `'${name}' exceeds the ${maxUploadSize} attachment limit.`;
}
