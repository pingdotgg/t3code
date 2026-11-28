// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// createRequire preserves adjacent Webpack chunks and native modules in bundled/SEA builds.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
let sdk: typeof import("@cursor/sdk") | undefined;
let sqlite: typeof import("@cursor/sdk/sqlite") | undefined;

export function loadCursorSdk(): typeof import("@cursor/sdk") {
  if (sdk !== undefined) return sdk;
  const start = performance.now();
  sdk = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
  if (process.env.HYAKKI_STARTUP_PROFILE_DIR) {
    performance.measure("provider.cursor.importSdk", { start });
  }
  return sdk;
}

export function loadCursorSqlite(): typeof import("@cursor/sdk/sqlite") {
  if (sqlite !== undefined) return sqlite;
  const start = performance.now();
  sqlite = requireCursorSdk("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite");
  if (process.env.HYAKKI_STARTUP_PROFILE_DIR) {
    performance.measure("provider.cursor.importSqliteStore", { start });
  }
  return sqlite;
}

export type CursorSdkErrorKind = "AuthenticationError" | "ConfigurationError" | "CursorSdkError";

const CURSOR_SDK_ERROR_KIND = Symbol.for("@t3tools/provider-cursor/sdkErrorKind");

export function tagCursorSdkError(error: Error, kind: CursorSdkErrorKind): Error {
  Reflect.set(error, CURSOR_SDK_ERROR_KIND, kind);
  return error;
}

export function getCursorSdkErrorKind(cause: unknown): CursorSdkErrorKind | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const tagged = Reflect.get(cause, CURSOR_SDK_ERROR_KIND);
  if (
    tagged === "AuthenticationError" ||
    tagged === "ConfigurationError" ||
    tagged === "CursorSdkError"
  ) {
    return tagged;
  }
  if (isCursorSdkError(cause, "AuthenticationError")) return "AuthenticationError";
  if (isCursorSdkError(cause, "ConfigurationError")) return "ConfigurationError";
  if (isCursorSdkError(cause, "CursorSdkError")) return "CursorSdkError";
  return undefined;
}

// Error classification must not initialize the SDK when the load itself failed.
export function isCursorSdkError<K extends CursorSdkErrorKind>(
  cause: unknown,
  kind: K,
): cause is InstanceType<(typeof import("@cursor/sdk"))[K]> {
  if (typeof cause === "object" && cause !== null) {
    const tagged = Reflect.get(cause, CURSOR_SDK_ERROR_KIND);
    if (
      tagged === kind ||
      (kind === "CursorSdkError" &&
        (tagged === "AuthenticationError" || tagged === "ConfigurationError"))
    ) {
      return true;
    }
  }
  return sdk !== undefined && cause instanceof sdk[kind];
}
