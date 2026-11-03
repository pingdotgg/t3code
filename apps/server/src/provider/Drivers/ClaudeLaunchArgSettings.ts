import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

export class ClaudeSettingsLaunchArgError extends Schema.TaggedError<ClaudeSettingsLaunchArgError>()(
  "ClaudeSettingsLaunchArgError",
  {
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude could not read the --settings launch argument${this.path === undefined ? "" : ` at ${this.path}`} as a JSON object. Fix it in the Claude launch arguments, then send the message again.`;
  }
}

const decodeClaudeLaunchArgSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Reads the --settings launch argument: a value starting with a brace is inline
 * JSON, anything else is a file path relative to the cwd.
 */
export const readClaudeLaunchArgSettings = Effect.fn("readClaudeLaunchArgSettings")(function* (
  launchArgs: string | undefined,
  cwd: string | undefined,
): Effect.fn.Return<
  { readonly [key: string]: unknown } | undefined,
  ClaudeSettingsLaunchArgError,
  FileSystem.FileSystem | Path.Path
> {
  const value = parseCliArgs(launchArgs ?? "").flags.settings;
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return yield* new ClaudeSettingsLaunchArgError({});
  // The CLI also wants a closing brace, but then malformed JSON, secrets included, would
  // become the file path in the error message.
  if (trimmed.startsWith("{")) {
    return yield* decodeClaudeLaunchArgSettings(trimmed).pipe(
      Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ cause })),
    );
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.resolve(cwd ?? ".", trimmed);
  return yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeClaudeLaunchArgSettings),
    Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ path: filePath, cause })),
  );
});

export const ClaudeBypassSettings = Schema.StructWithRest(
  Schema.Struct({
    disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
    permissions: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          disableBypassPermissionsMode: Schema.optionalKey(Schema.Literals(["disable", false])),
          disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export function claudeSdkBypassSettings(settings: typeof ClaudeBypassSettings.Type) {
  const { disableAutoMode, permissions, ...rest } = settings;
  const {
    disableBypassPermissionsMode,
    disableAutoMode: nestedAutoMode,
    ...permissionRest
  } = permissions ?? {};
  return {
    ...rest,
    ...(disableAutoMode === "disable" ? { disableAutoMode } : {}),
    ...(permissions
      ? {
          permissions: {
            ...permissionRest,
            ...(disableBypassPermissionsMode === "disable" ? { disableBypassPermissionsMode } : {}),
            ...(nestedAutoMode === "disable" ? { disableAutoMode: nestedAutoMode } : {}),
          },
        }
      : {}),
  };
}

// --settings travels to the SDK as options.settings, whose type only allows "disable", and the
// CLI drops the whole inline layer when a legacy `false` is present. Shapes the schema rejects
// keep their current pass-through; resolveBypassAvailability treats them as a bypass failure.
const decodeClaudeLaunchArgBypassSettingsOption = Schema.decodeUnknownOption(ClaudeBypassSettings);
export function claudeSdkLaunchArgSettings(settings: {
  readonly [key: string]: unknown;
}): ClaudeSdkSettings {
  const decoded = decodeClaudeLaunchArgBypassSettingsOption(settings);
  return (
    Option.isNone(decoded) ? settings : claudeSdkBypassSettings(decoded.value)
  ) as ClaudeSdkSettings;
}
