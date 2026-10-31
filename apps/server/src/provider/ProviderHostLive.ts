import { ChatImageAttachment, isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

const isChatImageAttachment = Schema.is(ChatImageAttachment);

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      persistImageAttachment: Effect.fn("ProviderHost.persistImageAttachment")(function* (input) {
        const id = createDeterministicAttachmentId(
          input.threadId,
          chatAttachmentStableKey(input.messageId, input.index, input.bytes),
        );
        const attachment = {
          type: "image" as const,
          id,
          name: `image-${input.index + 1}${inferImageExtension({ mimeType: input.mimeType })}`,
          mimeType: input.mimeType,
          sizeBytes: input.bytes.byteLength,
        };
        if (
          !isChatImageAttachment(attachment) ||
          !isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
        ) {
          return null;
        }
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (path === null) return null;
        // The id hashes the bytes and files only appear by rename, so an existing file is complete.
        if (yield* fileSystem.exists(path)) return attachment;
        // The stale-upload sweep removes a .part left by a crash.
        const partPath = `${path}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.part`;
        yield* fileSystem.writeFile(partPath, input.bytes).pipe(
          Effect.andThen(fileSystem.rename(partPath, path)),
          Effect.onError(() => fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)),
        );
        return attachment;
      }),
      // DocumentText owns the path-resolution span.
      resolveExtractedTextPath: Effect.fnUntraced(
        function* (path) {
          return yield* DocumentText.resolveExtractedTextPath(path);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
      credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
        return ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Crypto.Crypto, crypto),
        );
      }),
    });
  }),
);
