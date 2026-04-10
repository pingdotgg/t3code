import { Data, Context } from "effect";
import type { Effect } from "effect";

export class SecretStoreError extends Data.TaggedError("SecretStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "t3/auth/Services/ServerSecretStore",
) {}
