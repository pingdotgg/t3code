import {
  AttachmentMcpFailure,
  IsoDateTime,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type AttachmentMcpDiscardUploadInput,
  type AttachmentMcpDiscardUploadResult,
  type AttachmentMcpPrepareUploadInput,
  type AttachmentMcpPrepareUploadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  deletePendingAttachment,
  issueAttachmentUploadUrl,
  validateAttachmentUploadToken,
} from "../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class AttachmentMcpService extends Context.Service<
  AttachmentMcpService,
  {
    readonly prepareUpload: (
      scope: McpInvocationScope,
      input: AttachmentMcpPrepareUploadInput,
    ) => Effect.Effect<AttachmentMcpPrepareUploadResult, AttachmentMcpFailure>;
    readonly discardUpload: (
      scope: McpInvocationScope,
      input: AttachmentMcpDiscardUploadInput,
    ) => Effect.Effect<AttachmentMcpDiscardUploadResult, AttachmentMcpFailure>;
  }
>()("t3/mcp/AttachmentMcpService") {}

function failure(code: AttachmentMcpFailure["code"], message: string): AttachmentMcpFailure {
  return new AttachmentMcpFailure({ code, message });
}

const requireCapability = (scope: McpInvocationScope) =>
  scope.capabilities.has("orchestration")
    ? Effect.void
    : Effect.fail(
        failure(
          "capability_denied",
          "This MCP credential does not grant orchestration capabilities.",
        ),
      );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const issueUpload = (input: Parameters<typeof issueAttachmentUploadUrl>[0]) =>
    issueAttachmentUploadUrl(input).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
    );
  const discardPending = (attachmentId: string) =>
    deletePendingAttachment(attachmentId).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  const validateUploadToken = (token: string) =>
    validateAttachmentUploadToken(token).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
    );

  return AttachmentMcpService.of({
    prepareUpload: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const uploadInput =
          input.type === "file"
            ? {
                type: "file" as const,
                name: input.name,
                mimeType: input.mimeType,
                sizeBytes: input.sizeBytes,
              }
            : {
                type: "image" as const,
                name: input.name,
                mimeType:
                  input.mimeType as (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number],
                sizeBytes: input.sizeBytes,
              };
        const issued = yield* issueUpload(uploadInput).pipe(
          Effect.mapError(() =>
            failure("upload_error", "Unable to prepare a signed attachment upload."),
          ),
        );
        return {
          attachmentId: issued.attachmentId,
          type: input.type ?? "image",
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          upload: {
            method: "PUT",
            relativeUrl: issued.relativeUrl,
            expiresAt: IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(issued.expiresAt))),
          },
        };
      }),
    discardUpload: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        if (
          parseThreadSegmentFromAttachmentId(input.attachmentId) !==
          PENDING_ATTACHMENT_THREAD_SEGMENT
        ) {
          return yield* failure(
            "invalid_attachment",
            "Only a pending upload can be discarded; thread-owned attachments are immutable here.",
          );
        }
        const token = input.uploadRelativeUrl.split("/").at(-1) ?? "";
        const claims = yield* validateUploadToken(token);
        if (claims?.attachmentId !== input.attachmentId) {
          return yield* failure(
            "invalid_attachment",
            "The signed upload URL does not authorize this pending attachment id.",
          );
        }
        yield* discardPending(input.attachmentId);
        return { attachmentId: input.attachmentId, discarded: true };
      }),
  });
});

export const layer = Layer.effect(AttachmentMcpService, make);
