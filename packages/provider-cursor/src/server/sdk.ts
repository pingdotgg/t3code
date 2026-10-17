// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
let sdk: typeof import("@cursor/sdk") | undefined;
export const loadCursorSdk = () =>
  (sdk ??= requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk"));
let sqlite: typeof import("@cursor/sdk/sqlite") | undefined;
export const loadCursorSqlite = () =>
  (sqlite ??= requireCursorSdk("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite"));
