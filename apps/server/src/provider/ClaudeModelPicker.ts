import type { ClaudeSettings, ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { claudeManagedSettingsPath } from "./Drivers/ClaudeSkills.ts";

const ModelPickerSettings = fromLenientJson(
  Schema.Struct({
    modelPicker: Schema.optional(
      Schema.Struct({
        options: Schema.Array(Schema.Unknown),
        replaceBuiltInOptions: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
const ModelPickerRow = Schema.Struct({
  model: Schema.String,
  label: Schema.optional(Schema.String),
});

const decodeModelPickerSettings = Schema.decodeUnknownEffect(ModelPickerSettings);
const decodeModelPickerRow = Schema.decodeUnknownOption(ModelPickerRow);

export interface ClaudeModelPicker {
  readonly replaceBuiltInOptions: boolean;
  /** Configured labels keyed by model id, in picker order. */
  readonly labels: ReadonlyMap<string, string | undefined>;
}

// Claude Code ignores a project checkout's `modelPicker`, and the highest source
// that defines one replaces the rest, so the first hit wins and nothing merges.
export const readClaudeModelPicker = Effect.fn("readClaudeModelPicker")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const configDir = yield* resolveClaudeHomePath(claudeSettings, environment);
  const managedPath = claudeManagedSettingsPath(path, platform, environment);

  for (const settingsPath of [
    ...(managedPath ? [managedPath] : []),
    path.join(configDir, "settings.json"),
  ]) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    const picker = (yield* decodeModelPickerSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    ))?.modelPicker;
    if (!picker) continue;

    const labels = new Map<string, string | undefined>();
    for (const option of picker.options) {
      const row = Option.getOrUndefined(decodeModelPickerRow(option));
      const slug = row?.model.trim();
      if (row && slug && !labels.has(slug)) labels.set(slug, row.label?.trim() || undefined);
    }
    return labels.size === 0
      ? undefined
      : { replaceBuiltInOptions: picker.replaceBuiltInOptions === true, labels };
  }
  return undefined;
});

export function applyClaudeModelPicker(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  picker: ClaudeModelPicker | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!picker) return builtInModels;
  const builtInBySlug = new Map(builtInModels.map((model) => [model.slug, model]));
  // Rows naming a bundled model keep its effort and context controls. Any other
  // id goes to Claude Code verbatim with no controls, like a custom model.
  const listed = [...picker.labels].map(([slug, label]): ServerProviderModel => {
    const builtIn = builtInBySlug.get(slug);
    if (!builtIn) return { slug, name: label ?? slug, isCustom: false, capabilities: null };
    if (!label) return builtIn;
    const { shortName: _shortName, ...rest } = builtIn;
    return { ...rest, name: label };
  });
  return picker.replaceBuiltInOptions
    ? listed
    : [...listed, ...builtInModels.filter((model) => !picker.labels.has(model.slug))];
}
