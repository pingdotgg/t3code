import {
  ChatAttachmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    // Optional so standalone provider layers in tests probe at once.
    const lifecycleEvents = yield* Effect.serviceOption(
      ServerLifecycleEvents.ServerLifecycleEvents,
    );
    // Optional so hosts built without the preview layer still construct.
    const portDiscovery = yield* Effect.serviceOption(PortScanner.PortDiscovery);
    // Optional like the services above; without it the bundled policy still applies.
    const manifest = yield* Effect.serviceOption(ModelManifest.ModelManifest);
    const currentManifest = Option.match(manifest, {
      onNone: () => Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      onSome: (service) => service.current,
    });
    return ProviderHost.ProviderHost.of({
      compatibility: Effect.fn("ProviderHost.compatibility")(function* (driver, version) {
        return ModelManifest.providerCompatibility(yield* currentManifest, driver, version);
      }),
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
      ...Option.match(lifecycleEvents, {
        onNone: () => ({}),
        onSome: (events) => ({ awaitServerReady: events.awaitReady }),
      }),
      ...Option.match(portDiscovery, {
        onNone: () => ({}),
        onSome: (discovery) => ({ trackAgent: discovery.trackAgent }),
      }),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      saveRecoveredImage: Effect.fn("ProviderHost.saveRecoveredImage")(function* (input) {
        if (
          !isProviderSendTurnSupportedImageMimeType(input.mimeType) ||
          input.bytes.length === 0 ||
          input.bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        )
          return undefined;
        const id = createAttachmentId(input.threadId);
        if (!id) return undefined;
        const attachment = {
          type: "image" as const,
          id: ChatAttachmentId.make(id),
          mimeType: input.mimeType,
          name: input.name,
          sizeBytes: input.bytes.length,
        };
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (!path) return undefined;
        return yield* fileSystem.writeFile(path, input.bytes, { flag: "wx", mode: 0o600 }).pipe(
          Effect.as(attachment),
          Effect.orElseSucceed(() => undefined),
        );
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
          Effect.provideService(Digest.Digest, digest),
        );
      }),
    });
  }),
);
