import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/));
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
export const ExtensionManifest = Schema.Struct({
  id: Id,
  name: Schema.NonEmptyString,
  description: Schema.String,
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)),
  apiVersion: Schema.Literal(1),
  main: Schema.NonEmptyString,
  events: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  commands: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        title: Schema.NonEmptyString,
        description: Schema.String,
        inputSchema: Schema.optional(ObjectValue),
        menu: Schema.optional(Schema.Literals(["thread", "project"])),
      }),
    ),
  ),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Id, description: Schema.NonEmptyString, inputSchema: ObjectValue }),
    ),
  ),
  panels: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Id, title: Schema.NonEmptyString, entry: Schema.NonEmptyString }),
    ),
  ),
  settingsPages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        title: Schema.NonEmptyString,
        description: Schema.optional(Schema.String),
        settings: Schema.optional(Schema.Array(Schema.String)),
        panelId: Schema.optional(Id),
      }),
    ),
  ),
  settings: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        title: Schema.String,
        description: Schema.String,
        type: Schema.Literals(["string", "number", "boolean"]),
        default: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
      }),
    ),
  ),
  statusItems: Schema.optional(
    Schema.Array(Schema.Struct({ id: Id, text: Schema.String, command: Id })),
  ),
});
export type ExtensionManifest = typeof ExtensionManifest.Type;
export const ExtensionInfo = Schema.Struct({
  manifest: ExtensionManifest,
  source: Schema.String,
  sourceType: Schema.Literals(["local", "npm"]),
  enabled: Schema.Boolean,
  status: Schema.Literals(["disabled", "starting", "running", "failed"]),
  diagnostic: Schema.optional(Schema.String),
  runtimeId: Schema.optional(Schema.String),
  settings: ObjectValue,
});
export type ExtensionInfo = typeof ExtensionInfo.Type;
export const ExtensionTarget = Schema.Struct({ id: Id });
export const ExtensionInstallInput = Schema.Struct({
  source: Schema.NonEmptyString,
  sourceType: Schema.Literals(["local", "npm"]),
});
export const ExtensionManageInput = Schema.Struct({
  id: Id,
  action: Schema.Literals(["enable", "disable", "reload", "update", "uninstall"]),
});
export const ExtensionSettingsInput = Schema.Struct({ id: Id, settings: ObjectValue });
export const ExtensionInvokeInput = Schema.Struct({
  id: Id,
  kind: Schema.Literals(["command", "tool"]),
  name: Id,
  input: Schema.Unknown,
  context: Schema.optional(
    Schema.Struct({
      threadId: Schema.optional(Schema.String),
      projectId: Schema.optional(Schema.String),
      surface: Schema.optional(Schema.Literals(["web", "desktop", "mobile", "agent"])),
    }),
  ),
});
export type ExtensionInvokeInput = typeof ExtensionInvokeInput.Type;
export const ExtensionPanelInput = Schema.Struct({
  id: Id,
  panelId: Id,
  runtimeId: Schema.optional(Schema.String),
});
export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", {
  operation: Schema.String,
  id: Schema.String,
  reason: Schema.Literals([
    "invalid-manifest",
    "not-found",
    "conflict",
    "not-running",
    "invalid-input",
    "runtime-failed",
    "install-failed",
    "storage-failed",
  ]),
  cause: Schema.optional(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.optional(Schema.Unknown), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.omit(),
    }),
  ),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Extension ${this.id}: ${this.reason} (${this.operation}).${this.detail ? ` ${this.detail}` : ""}`;
  }
}
