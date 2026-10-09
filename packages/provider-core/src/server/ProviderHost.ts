/**
 * ProviderHost — what a provider package may ask of the server it runs in.
 *
 * Drivers and adapters run inside a T3 server but must not import it. The
 * server provides this one service; everything a provider needs from its
 * environment (directories, server settings, background demand, attachment
 * files) goes through it, so a provider package depends only on
 * `@t3tools/provider-core` and its own protocol code.
 *
 * @module provider-core/server/host
 */
import type {
  BackgroundScope,
  ChatAttachment,
  ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderCredentialError } from "./errors.ts";

export interface ProviderHostPaths {
  /** Directory the server was started in; the fallback cwd for sessions without a project. */
  readonly cwd: string;
  /** T3 home. */
  readonly baseDir: string;
  /** Server-owned state directory under the T3 home. */
  readonly stateDir: string;
  /** Scratch space for provider probes and generated helper files. */
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

/** One opaque credential blob in the server's secret store. Only the provider decodes it. */
export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

interface ProviderHostService {
  readonly paths: ProviderHostPaths;
  readonly settings: {
    readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
    /** Every settings change after subscription, starting with the next one. */
    readonly changes: Stream.Stream<ServerSettings>;
    /** Changes buffered from the moment the scoped subscription is acquired. */
    readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  };
  /** Whether background work for `scope` should run now (client demand and host power). */
  readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
  /**
   * Absolute path of a stored chat attachment, or `null` when its id does not
   * resolve inside the attachments directory.
   */
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
  /** The credentials stored for `bindingId`, usually an instance id, under a provider-chosen namespace. */
  readonly credentials: (
    namespace: string,
    bindingId: string,
  ) => Effect.Effect<ProviderCredentials>;
}

export class ProviderHost extends Context.Service<ProviderHost, ProviderHostService>()(
  "@t3tools/provider-core/server/ProviderHost",
) {}
