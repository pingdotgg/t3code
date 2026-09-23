import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ExtensionNamePart = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-_.]*$/i),
);

const ExtensionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(257),
  Schema.isPattern(/^[a-z0-9][a-z0-9-_.]*\.[a-z0-9][a-z0-9-_]*$/i),
);
const ExtensionViewContainer = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  icon: Schema.NullOr(Schema.String),
  views: ForwardCompatibleArray(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: Schema.String,
      type: Schema.Literals(["tree", "webview"]),
    }),
  ),
});
export const InstalledExtension = Schema.Struct({
  id: ExtensionId,
  displayName: Schema.String,
  description: Schema.String,
  publisher: Schema.String,
  version: TrimmedNonEmptyString,
  iconUrl: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  microsoftOnly: Schema.Boolean,
  viewContainers: ForwardCompatibleArray(ExtensionViewContainer),
  customEditors: ForwardCompatibleArray(
    Schema.Struct({ viewType: TrimmedNonEmptyString, displayName: Schema.String }),
  ),
  commands: ForwardCompatibleArray(
    Schema.Struct({
      command: TrimmedNonEmptyString,
      title: Schema.String,
      category: Schema.NullOr(Schema.String),
    }),
  ),
});
export type InstalledExtension = typeof InstalledExtension.Type;

const ExtensionHostStatus = Schema.Literals([
  "notInstalled",
  "downloading",
  "starting",
  "ready",
  "failed",
  "unsupported",
]);
export const ExtensionsState = Schema.Struct({
  host: ExtensionHostStatus,
  hostMessage: Schema.NullOr(Schema.String),
  extensions: ForwardCompatibleArray(InstalledExtension),
});
export type ExtensionsState = typeof ExtensionsState.Type;

export const ExtensionInstallSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("openVsx"),
    namespace: ExtensionNamePart,
    name: ExtensionNamePart,
    version: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  }),
  Schema.Struct({
    type: Schema.Literal("vsix"),
    uploadId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
]);
export type ExtensionInstallSource = typeof ExtensionInstallSource.Type;

export const ExtensionInstallInput = Schema.Struct({ source: ExtensionInstallSource });
export type ExtensionInstallInput = typeof ExtensionInstallInput.Type;

export const ExtensionTargetInput = Schema.Struct({ id: ExtensionId });
export type ExtensionTargetInput = typeof ExtensionTargetInput.Type;

export const ExtensionSetEnabledInput = Schema.Struct({ id: ExtensionId, enabled: Schema.Boolean });
export type ExtensionSetEnabledInput = typeof ExtensionSetEnabledInput.Type;

export const ExtensionHostConnection = Schema.Struct({
  basePath: TrimmedNonEmptyString,
  connectionToken: TrimmedNonEmptyString,
  wsTicket: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  quality: TrimmedNonEmptyString,
});
export type ExtensionHostConnection = typeof ExtensionHostConnection.Type;

export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", {
  operation: Schema.Literals(["host", "install", "uninstall", "setEnabled", "list", "connect"]),
  detail: Schema.String,
  extensionId: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.extensionId
      ? `Extension ${this.operation} failed for ${this.extensionId}: ${this.detail}`
      : `Extension ${this.operation} failed: ${this.detail}`;
  }
}
