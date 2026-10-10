/** Options for a local Secrets Store secret binding. */
export interface SecretsStoreSecretProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Identifier of the Secrets Store containing the secret. Stores with the
   * same identifier share data; the identifier also determines where data
   * is persisted on disk.
   */
  readonly storeId: string;
  /** Name of the secret within the store. */
  readonly secretName: string;
}

/**
 * Service designator props passed to the secret entrypoint service
 * (`ctx.props`). A single `secrets-store:secret` service hosts every
 * `secrets_store_secret` binding; each binding's designator carries the
 * store/secret identity it should address.
 */
export interface SecretsStoreSecretServiceProps {
  readonly storeId: string;
  readonly secretName: string;
}

/**
 * Service designator props passed to the store (KV) service entrypoint
 * (`ctx.props`). A single `secrets-store` service hosts every store; each
 * designator carries the store it should address. Used by the admin/seeding
 * path (`admin`), which exposes a store as a raw KV namespace.
 */
export interface SecretsStoreStoreServiceProps {
  readonly storeId: string;
}

export const SERVICE_SECRETS_STORE = "secrets-store";
export const SERVICE_SECRETS_STORE_STORAGE = "secrets-store:storage";
export const SERVICE_SECRETS_STORE_SECRET = "secrets-store:secret";
export const SECRETS_STORE_SECRET_ENTRYPOINT = "SecretsStoreSecret";

/**
 * The Durable Object class hosting a store's data. Miniflare's secrets-store
 * plugin reuses the KV namespace object verbatim
 * (`workers-sdk/packages/miniflare/src/plugins/secret-store/index.ts`); so
 * does this port — the store service re-exports `KVNamespaceObject` from the
 * KV simulator under its own service + storage.
 */
export const SECRETS_STORE_OBJECT_CLASS_NAME = "KVNamespaceObject";

/** Service binding through which the secret entrypoint reaches its store. */
export const BINDING_SECRETS_STORE_STORE = "STORE";
