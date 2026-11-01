import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";

const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));

/** The environment's settings.json as written: only the keys that differ from defaults. */
export type SparseSettings = typeof SparseSettings.Type;

export class SettingsUnreadableError extends Schema.TaggedError<SettingsUnreadableError>()(
  "SettingsUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix its permissions, then run this again.`;
  }
}

export class SettingsMalformedError extends Schema.TaggedError<SettingsMalformedError>()(
  "SettingsMalformedError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.settingsPath} is not a JSON object. Fix or remove it, then run this again.`;
  }
}

export class SettingsBusyError extends Schema.TaggedError<SettingsBusyError>()(
  "SettingsBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing (gave up after ${this.attempts} attempts). Try again.`;
  }
}

export class SettingsWriteError extends Schema.TaggedError<SettingsWriteError>()(
  "SettingsWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);

/** The paths of the environment a settings command targets: `--base-dir`, else `T3CODE_HOME`. */
export const resolveCliServerPaths = Effect.fn(function* (explicitBaseDir: Option.Option<string>) {
  const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  return yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
});

/** Propagate read errors to avoid overwriting unread settings with a sparse file. */
export const readSettingsObject = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(settingsPath)
    .pipe(Effect.mapError((cause) => new SettingsUnreadableError({ settingsPath, cause })));
  if (!exists) return { raw: "", settings: {} };

  const raw = yield* fs
    .readFileString(settingsPath)
    .pipe(Effect.mapError((cause) => new SettingsUnreadableError({ settingsPath, cause })));
  if (raw.trim().length === 0) return { raw, settings: {} };

  const settings = yield* decodeSettingsJson(raw).pipe(
    Effect.mapError((cause) => new SettingsMalformedError({ settingsPath, cause })),
  );
  return { raw, settings };
});

/** The server's in-process semaphore cannot serialize writes from this process. */
const CONCURRENT_WRITE_ATTEMPTS = 5;

/**
 * Rewrites settings.json with `update`, retrying when another writer changed it meanwhile.
 * A running server picks the change up from its file watcher.
 */
export const updateSettingsObject = Effect.fn(function* (
  settingsPath: string,
  update: (settings: SparseSettings) => Effect.Effect<SparseSettings>,
) {
  const fs = yield* FileSystem.FileSystem;

  for (let attempt = 1; ; attempt++) {
    const { raw, settings } = yield* readSettingsObject(settingsPath);
    const contents = yield* encodeSettingsJson(yield* update(settings));
    const current = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
    if (current !== raw) {
      if (attempt >= CONCURRENT_WRITE_ATTEMPTS) {
        return yield* new SettingsBusyError({ settingsPath, attempts: CONCURRENT_WRITE_ATTEMPTS });
      }
      continue;
    }

    yield* writeFileStringAtomically({
      filePath: settingsPath,
      contents: `${contents}\n`,
    }).pipe(Effect.mapError((cause) => new SettingsWriteError({ settingsPath, cause })));
    return;
  }
});
