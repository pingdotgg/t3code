export interface LegacyRow extends Record<string, string | number | null> {
  id: string;
  run_at: number;
  repeat_ms: number | null;
  payload: string;
}

export interface Column extends Record<string, string | number> {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export interface CallbackRow extends Record<string, string | number> {
  callback: string;
  id: string;
  version: string;
  run_at: number;
  payload: string;
}

export interface Delivery {
  version: "v1" | "v2";
  channel: "legacy" | "callback";
  id: string;
  payload: unknown;
}

export interface SchemaObject extends Record<string, string | null> {
  name: string;
  type: string;
  sql: string | null;
}

export interface SchemaVersion extends Record<string, number> {
  id: number;
  version: number;
}

export interface MigrationProbe {
  before: Snapshot;
  after: Snapshot;
  failure: {
    tag: string;
    message: string;
    version: number | null;
    supportedVersion: number | null;
  } | null;
  retryBefore: Snapshot | null;
  recovered: Snapshot | null;
}

export interface Snapshot {
  schema: SchemaObject[];
  schemaRows: SchemaVersion[];
  schemaVersion: number | null;
  version: "v1" | "v2";
  id: string;
  marker: string | null;
  constructors: string[];
  legacyRows: LegacyRow[];
  legacyColumns: Column[];
  callbacks: CallbackRow[];
  tables: string[];
  alarm: number | null;
  deliveries: Delivery[];
}
