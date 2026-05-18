import type { Base64ImageSource } from "@factory/droid-sdk";
import type * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { DROID_PROVIDER, type DroidAdapterShape } from "./DroidAdapterTypes.ts";

const SUPPORTED_DROID_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

type SupportedDroidImageMimeType = (typeof SUPPORTED_DROID_IMAGE_MIME_TYPES)[number];

const isSupportedDroidImageMimeType = (value: string): value is SupportedDroidImageMimeType =>
  (SUPPORTED_DROID_IMAGE_MIME_TYPES as ReadonlyArray<string>).includes(value);

type DroidAttachments = NonNullable<Parameters<DroidAdapterShape["sendTurn"]>[0]["attachments"]>;

export function resolveDroidImages(
  attachments: DroidAttachments,
  dependencies: {
    readonly attachmentsDir: string;
    readonly fileSystem: FileSystem.FileSystem;
  },
) {
  const { attachmentsDir, fileSystem } = dependencies;
  return Effect.forEach(
    attachments,
    (attachment) =>
      Effect.gen(function* () {
        if (!isSupportedDroidImageMimeType(attachment.mimeType)) {
          return yield* new ProviderAdapterRequestError({
            provider: DROID_PROVIDER,
            method: "turn/start",
            detail: `Unsupported Droid image attachment type '${attachment.mimeType}'.`,
          });
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: DROID_PROVIDER,
            method: "turn/start",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: DROID_PROVIDER,
                method: "turn/start",
                detail: `Failed to read attachment file: ${cause.message}.`,
                cause,
              }),
          ),
        );
        return {
          type: "base64",
          data: Buffer.from(bytes).toString("base64"),
          mediaType: attachment.mimeType,
        } satisfies Base64ImageSource;
      }),
    { concurrency: 1 },
  );
}
