import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EditorId } from "./editor.ts";

export const MAX_OPEN_WITH_ENTRIES = 64;
export const MAX_OPEN_WITH_ARGUMENTS = 64;
export const MAX_OPEN_WITH_ID_LENGTH = 64;
export const MAX_OPEN_WITH_NAME_LENGTH = 120;
export const MAX_OPEN_WITH_PATH_LENGTH = 4_096;
export const MAX_OPEN_WITH_ARGUMENT_LENGTH = 4_096;

export const OpenWithEntryId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_OPEN_WITH_ID_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("OpenWithEntryId"));
export type OpenWithEntryId = typeof OpenWithEntryId.Type;

export const OpenWithEntryKind = Schema.Literals(["editor", "terminal", "file-manager", "other"]);
export type OpenWithEntryKind = typeof OpenWithEntryKind.Type;

export const OpenWithDirectoryMode = Schema.Literals([
  "open-target",
  "working-directory",
  "custom-arguments",
]);
export type OpenWithDirectoryMode = typeof OpenWithDirectoryMode.Type;

const OpenWithPath = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_OPEN_WITH_PATH_LENGTH));
const OpenWithArgument = Schema.String.check(Schema.isMaxLength(MAX_OPEN_WITH_ARGUMENT_LENGTH));

export const OpenWithInvocation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mac-application"),
    applicationPath: OpenWithPath,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    executable: OpenWithPath,
  }),
]);
export type OpenWithInvocation = typeof OpenWithInvocation.Type;

export const OpenWithEntry = Schema.Struct({
  id: OpenWithEntryId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_OPEN_WITH_NAME_LENGTH)),
  kind: OpenWithEntryKind,
  invocation: OpenWithInvocation,
  directoryMode: OpenWithDirectoryMode,
  arguments: Schema.Array(OpenWithArgument).check(Schema.isMaxLength(MAX_OPEN_WITH_ARGUMENTS)),
});
export type OpenWithEntry = typeof OpenWithEntry.Type;

export const OpenWithEntries = Schema.Array(OpenWithEntry).check(
  Schema.isMaxLength(MAX_OPEN_WITH_ENTRIES),
);

export const OpenWithEntryRef = Schema.Union([
  Schema.Struct({ type: Schema.Literal("builtin"), id: EditorId }),
  Schema.Struct({ type: Schema.Literal("custom"), id: OpenWithEntryId }),
]);
export type OpenWithEntryRef = typeof OpenWithEntryRef.Type;

export const DesktopApplicationSelection = Schema.Struct({
  applicationPath: OpenWithPath,
  suggestedName: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_OPEN_WITH_NAME_LENGTH)),
  iconDataUrl: Schema.NullOr(Schema.String),
});
export type DesktopApplicationSelection = typeof DesktopApplicationSelection.Type;

export const OpenWithEntryPresentation = Schema.Struct({
  entryId: OpenWithEntryId,
  available: Schema.Boolean,
  iconDataUrl: Schema.NullOr(Schema.String),
  unavailableReason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OpenWithEntryPresentation = typeof OpenWithEntryPresentation.Type;

export const DesktopOpenWithInput = Schema.Struct({
  environmentId: EnvironmentId,
  entryId: OpenWithEntryId,
  directory: OpenWithPath,
});
export type DesktopOpenWithInput = typeof DesktopOpenWithInput.Type;

export class OpenWithEnvironmentError extends Schema.TaggedErrorClass<OpenWithEnvironmentError>()(
  "OpenWithEnvironmentError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "Custom applications are only available in the primary desktop environment.";
  }
}

export class OpenWithMissingEntryError extends Schema.TaggedErrorClass<OpenWithMissingEntryError>()(
  "OpenWithMissingEntryError",
  { entryId: OpenWithEntryId },
) {
  override get message(): string {
    return `The configured application '${this.entryId}' no longer exists.`;
  }
}

export const OpenWithInvalidTargetReason = Schema.Literals([
  "relative",
  "missing",
  "not-directory",
]);
export type OpenWithInvalidTargetReason = typeof OpenWithInvalidTargetReason.Type;

export class OpenWithInvalidTargetError extends Schema.TaggedErrorClass<OpenWithInvalidTargetError>()(
  "OpenWithInvalidTargetError",
  { directory: Schema.String, reason: OpenWithInvalidTargetReason },
) {
  override get message(): string {
    return `Cannot open '${this.directory}' because it is ${
      this.reason === "relative"
        ? "not an absolute path"
        : this.reason === "missing"
          ? "missing"
          : "not a directory"
    }.`;
  }
}

export class OpenWithUnavailableApplicationError extends Schema.TaggedErrorClass<OpenWithUnavailableApplicationError>()(
  "OpenWithUnavailableApplicationError",
  { entryId: OpenWithEntryId, executable: Schema.String },
) {
  override get message(): string {
    return `The application configured for '${this.entryId}' is unavailable: ${this.executable}`;
  }
}

export const OpenWithBundleResolutionReason = Schema.Literals([
  "invalid-application-path",
  "missing-info-plist",
  "malformed-info-plist",
  "missing-executable",
]);
export type OpenWithBundleResolutionReason = typeof OpenWithBundleResolutionReason.Type;

export class OpenWithBundleResolutionError extends Schema.TaggedErrorClass<OpenWithBundleResolutionError>()(
  "OpenWithBundleResolutionError",
  {
    applicationPath: Schema.String,
    reason: OpenWithBundleResolutionReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to resolve the executable in macOS application '${this.applicationPath}' (${this.reason}).`;
  }
}

export class OpenWithSpawnError extends Schema.TaggedErrorClass<OpenWithSpawnError>()(
  "OpenWithSpawnError",
  {
    entryId: OpenWithEntryId,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to launch '${this.entryId}' with '${this.command}'.`;
  }
}

export const OpenWithLaunchError = Schema.Union([
  OpenWithEnvironmentError,
  OpenWithMissingEntryError,
  OpenWithInvalidTargetError,
  OpenWithUnavailableApplicationError,
  OpenWithBundleResolutionError,
  OpenWithSpawnError,
]);
export type OpenWithLaunchError = typeof OpenWithLaunchError.Type;
