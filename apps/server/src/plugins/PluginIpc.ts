/**
 * Messages between the server and one plugin child, carried as
 * newline-delimited JSON on the child's fd 3 (see pluginIpcFraming.ts).
 *
 * Both ends ship in the same server build, so this protocol carries no
 * version: only the plugin API (PLUGIN_API_VERSION) is versioned. The server
 * decodes every child message with these schemas; a message that fails to
 * decode or exceeds the byte bound gets the child killed.
 *
 * Every `Invoke` is answered by exactly one `Succeeded` or `Failed` with the
 * same `requestId`, including after `Cancel`; that answer is how the server
 * learns a cancelled call has settled.
 */
import { PluginId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const RequestId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Name a plugin registers a handler under, and the server invokes it by. */
export const PluginHandlerName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
);

const PluginErrorMessage = Schema.String.check(Schema.isMaxLength(2000));

const PluginLogLevel = Schema.Literals(["debug", "info", "warn", "error"]);
export type PluginLogLevel = typeof PluginLogLevel.Type;

const PluginHostMessage = Schema.TaggedUnion({
  Activate: {
    pluginId: PluginId,
    version: Schema.String,
    apiVersion: Schema.Int,
    entryPath: Schema.String,
    proposedApi: Schema.Boolean,
    maxMessageBytes: Schema.Int,
  },
  Invoke: { requestId: RequestId, handler: PluginHandlerName, input: Schema.Json },
  Cancel: { requestId: RequestId },
  Deactivate: {},
});
export type PluginHostMessage = typeof PluginHostMessage.Type;

const PluginChildMessage = Schema.TaggedUnion({
  Ready: {},
  ActivationFailed: { message: PluginErrorMessage },
  /** The entry cannot load on any runtime this server ships on; retrying cannot help. */
  Incompatible: { message: PluginErrorMessage },
  Succeeded: { requestId: RequestId, value: Schema.Json },
  Failed: { requestId: RequestId, message: PluginErrorMessage },
  Log: { level: PluginLogLevel, message: Schema.String.check(Schema.isMaxLength(4000)) },
  Deactivated: {},
});
export type PluginChildMessage = typeof PluginChildMessage.Type;

export const decodePluginChildMessage = Schema.decodeUnknownExit(
  Schema.fromJsonString(PluginChildMessage),
);
export const encodePluginHostMessage = Schema.encodeExit(Schema.fromJsonString(PluginHostMessage));
