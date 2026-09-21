// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
export const {
  Agent,
  AuthenticationError,
  Cursor,
  CursorSdkError,
  FileCredentialStore,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
