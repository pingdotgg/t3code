import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const EmailMessageWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/send-email/EmailMessage.worker",
    ),
};
const SendEmailBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/send-email/SendEmailBinding.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import {
  formatExtensionModule,
  formatInternalWorkerModules,
} from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type {
  SendEmailProps,
  SendEmailServiceProps,
} from "./SendEmailOptions.shared.ts";
import {
  BINDING_SEND_EMAIL_DIRECTORY,
  BINDING_SEND_EMAIL_DISK,
  SEND_EMAIL_ENTRYPOINT,
  SERVICE_SEND_EMAIL,
  SERVICE_SEND_EMAIL_STORAGE,
} from "./SendEmailOptions.shared.ts";

export class SendEmail extends Plugin.Service<
  SendEmail,
  {
    /**
     * Record that a local `send_email` binding is in use (so the send-email
     * services are only emitted when at least one binding exists) and resolve
     * the service designator the binding should target: the shared
     * `send-email` service's `SendEmailBinding` entrypoint, with the
     * per-binding address restrictions carried via designator props.
     */
    readonly register: (
      props: SendEmailServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/SendEmail") {}

export const SendEmailLive = Layer.effect(
  SendEmail,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "SendEmail",
          message:
            "Cannot configure email persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "email");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "SendEmail",
              message: `Failed to create email persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        persistPath,
        service: {
          name: SERVICE_SEND_EMAIL_STORAGE,
          disk: { path: persistPath, writable: true },
        } satisfies WorkerdConfig.Service,
      };
    });

    return SendEmail.of(
      Effect.gen(function* () {
        // Workerd does not natively expose the `EmailMessage` class that the
        // Cloudflare Workers runtime provides, so we always ship the
        // `cloudflare-internal:email` shim (matching upstream Miniflare) —
        // both the local simulator and the remote proxy rely on user code
        // being able to construct `EmailMessage` instances.
        const emailMessage = yield* formatExtensionModule(EmailMessageWorker);
        let used = false;

        return {
          extensions: [
            {
              modules: [
                {
                  name: "cloudflare-internal:email",
                  internal: true,
                  esModule: emailMessage,
                },
              ],
            },
          ],
          api: {
            register: (props: SendEmailServiceProps) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_SEND_EMAIL,
                  entrypoint: SEND_EMAIL_ENTRYPOINT,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const { persistPath, service: storageService } =
              yield* makeStorageService;
            const sendEmailService: WorkerdConfig.Service = {
              name: SERVICE_SEND_EMAIL,
              worker: {
                compatibilityDate: "2025-03-17",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(SendEmailBindingWorker.worker),
                ),
                bindings: [
                  {
                    name: BINDING_SEND_EMAIL_DISK,
                    service: { name: SERVICE_SEND_EMAIL_STORAGE },
                  },
                  {
                    name: BINDING_SEND_EMAIL_DIRECTORY,
                    json: JSON.stringify(persistPath),
                  },
                ],
              },
            };
            return { services: [storageService, sendEmailService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind to a deployed `send_email` binding via the remote bindings proxy.
 *
 * Also registers the `cloudflare-internal:email` extension that exposes
 * the `EmailMessage` class to user code (workerd does not ship it
 * natively), matching the upstream Miniflare behavior.
 */
export const remote = (
  props: SendEmailProps,
): BindingHook<RemoteBindings | SendEmail> =>
  Plugin.use(SendEmail, () =>
    makeRemoteBinding(
      {
        name: props.binding,
        type: "send_email",
        destinationAddress: props.destinationAddress,
        allowedDestinationAddresses: props.allowedDestinationAddresses,
        allowedSenderAddresses: props.allowedSenderAddresses,
      },
      (service) => ({
        name: props.binding,
        service,
      }),
    ),
  );

/**
 * Bind a local `send_email` simulator for `alchemy dev`. `send()` validates
 * the message (sender/recipient allow-lists, MIME parseability, `Message-ID`,
 * `From:` header matching the envelope sender) exactly like Miniflare,
 * persists it under `{storage}/email` (`.eml` for raw messages; text/html/
 * attachments from the MessageBuilder API under `text/`, `html/` and
 * `attachment/`) and logs the written file path — instead of delivering real
 * mail. Opt into the real, remote binding with `dev: { remote: true }`.
 *
 * Reuses the `cloudflare-internal:email` `EmailMessage` shim registered by
 * {@link SendEmailLive} (same as {@link remote}), so user code can still
 * construct `EmailMessage` instances in dev.
 */
export const local = (props: SendEmailProps): BindingHook<SendEmail> =>
  Plugin.use(SendEmail, (sendEmail) =>
    Effect.map(
      sendEmail.api.register({
        destinationAddress: props.destinationAddress,
        allowedDestinationAddresses: props.allowedDestinationAddresses,
        allowedSenderAddresses: props.allowedSenderAddresses,
      }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        service,
      }),
    ),
  );
