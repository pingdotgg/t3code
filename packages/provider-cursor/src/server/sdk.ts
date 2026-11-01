// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// createRequire loads the disk-backed SDK and adjacent chunks even from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
const sdkImportStart = performance.now();
export const {
  Agent,
  AuthenticationError,
  ConfigurationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
  performance.measure("provider.cursor.importSdk", { start: sdkImportStart });
}
const sqliteImportStart = performance.now();
export const { SqliteLocalAgentStore } = requireCursorSdk(
  "@cursor/sdk/sqlite",
) as typeof import("@cursor/sdk/sqlite");
if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
  performance.measure("provider.cursor.importSqliteStore", { start: sqliteImportStart });
}
