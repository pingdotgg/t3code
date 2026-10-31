import type {
  BackgroundScope,
  ChatAttachment,
  ChatImageAttachment,
  MessageId,
  ServerSettings,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderCredentialError } from "./errors.ts";

export interface ProviderHostPaths {
  readonly cwd: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

export class ProviderHost extends Context.Service<
  ProviderHost,
  {
    readonly paths: ProviderHostPaths;
    readonly settings: {
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
      /** Runs `use` on a settings snapshot that no settings write can change until it finishes. */
      readonly withSnapshot: <A, E, R>(
        use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | ServerSettingsError, R>;
      readonly changes: Stream.Stream<ServerSettings>;
      /** Changes buffered from the moment the scoped subscription is acquired. */
      readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    };
    readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    /** Absolute attachment path, or null if the ID does not resolve inside attachmentsDir. */
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    /**
     * Stores provider-held image bytes as a thread attachment. The same thread, message, index
     * and bytes always yield the same attachment. Null for a type T3 cannot send or over 10 MiB.
     */
    readonly persistImageAttachment: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly index: number;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<ChatImageAttachment | null, PlatformError.PlatformError>;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly credentials: (
      namespace: string,
      bindingId: string,
    ) => Effect.Effect<ProviderCredentials>;
  }
>()("@t3tools/provider-core/server/ProviderHost") {}
