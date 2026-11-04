// Both IPC endpoints ship together; only the public plugin API is versioned.
// Every Invoke must receive one result, including after Cancel, so cancellation can release its slot.
import { PluginId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const RequestId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Name a plugin registers a handler under, and the server invokes it by. */
export const PluginHandlerName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
);

const PluginErrorMessage = Schema.String.check(Schema.isMaxLength(2000));

/** A server method a capability serves to plugins, such as `settings.get`. */
const PluginHostMethodName = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/),
);

const PluginLogLevel = Schema.Literals(["debug", "info", "warn", "error"]);
export type PluginLogLevel = typeof PluginLogLevel.Type;

const PluginHostMessage = Schema.TaggedUnion({
  Activate: {
    pluginId: PluginId,
    version: Schema.String,
    apiVersion: Schema.Int,
    entryPath: Schema.String,
    proposedApi: Schema.Boolean,
    /** The manifest's capabilities, so the child offers only the APIs they grant. */
    capabilities: Schema.Array(Schema.String),
    maxMessageBytes: Schema.Int,
  },
  Invoke: { requestId: RequestId, handler: PluginHandlerName, input: Schema.Json },
  Cancel: { requestId: RequestId },
  Deactivate: {},
  HostCallSucceeded: { requestId: RequestId, value: Schema.Json },
  HostCallFailed: { requestId: RequestId, message: PluginErrorMessage },
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
  HostCall: { requestId: RequestId, method: PluginHostMethodName, input: Schema.Json },
});
export type PluginChildMessage = typeof PluginChildMessage.Type;

export const decodePluginChildMessage = Schema.decodeUnknownExit(
  Schema.fromJsonString(PluginChildMessage),
);
export const encodePluginHostMessage = Schema.encodeExit(Schema.fromJsonString(PluginHostMessage));
