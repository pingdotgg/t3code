/** Options for a local KV namespace binding. */
export interface KvNamespaceProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Namespace identifier, defaults to the binding name. Namespaces with the
   * same identifier share data; the identifier also determines where data is
   * persisted on disk.
   */
  readonly id?: string;
}

/**
 * Service designator props passed to the KV service entrypoint (`ctx.props`).
 * A single `kv` service hosts every namespace; each binding's designator
 * carries the namespace it should address.
 */
export interface KvServiceProps {
  readonly namespaceId: string;
}

export const SERVICE_KV = "kv";
export const SERVICE_KV_STORAGE = "kv:storage";
export const KV_OBJECT_CLASS_NAME = "KVNamespaceObject";

export const BINDING_KV_OBJECT = "OBJECT";
export const BINDING_KV_BLOBS = "BLOBS";
export const BINDING_KV_ENABLE_CONTROL_ENDPOINTS = "ENABLE_CONTROL_ENDPOINTS";

/**
 * Internal header carrying the namespace id (URI-encoded) from the entry
 * `fetch` handler to the Durable Object, which needs it to namespace blob
 * paths on disk.
 */
export const HEADER_KV_NAMESPACE = "CF-Runtime-KV-Namespace";
/**
 * Internal header marking a control operation (fake timers, storage
 * inspection). The request body is JSON `{ name, args }`. Only honoured when
 * control endpoints are enabled; used by tests.
 */
export const HEADER_KV_CONTROL_OP = "CF-Runtime-KV-Control-Op";
