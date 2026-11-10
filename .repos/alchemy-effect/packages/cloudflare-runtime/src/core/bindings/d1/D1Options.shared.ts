/** Options for a local D1 database binding. */
export interface D1Props {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Database identifier, defaults to the binding name. Bindings with the same
   * identifier share data; the identifier also determines where data is
   * persisted on disk.
   */
  readonly id?: string;
}

/**
 * Service designator props passed to the D1 service entrypoint (`ctx.props`).
 * A single `d1` service hosts every database; each binding's designator
 * carries the database it should address.
 */
export interface D1ServiceProps {
  readonly databaseId: string;
}

export const SERVICE_D1 = "d1";
export const SERVICE_D1_STORAGE = "d1:storage";
export const D1_OBJECT_CLASS_NAME = "D1DatabaseObject";

export const BINDING_D1_OBJECT = "OBJECT";
