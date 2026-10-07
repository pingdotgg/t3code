/**
 * ManagedSettings - Organization policy laid over the user's settings.json.
 *
 * An administrator deploys a document with the same shape as settings.json.
 * Every key it sets wins over the user's own value, and clients show that
 * setting as locked. Objects merge key by key; scalars and arrays replace the
 * user's value whole. The user's settings.json is never rewritten with policy
 * values, so removing a policy hands the user's own values back.
 *
 * Sources, lowest precedence first:
 * - macOS: `/Library/Application Support/T3Code/managed-settings.json`
 * - macOS MDM: the `com.t3tools.t3code` managed preferences domain, which a
 *   configuration profile installs at
 *   `/Library/Managed Preferences/com.t3tools.t3code.plist`
 * - Linux: `/etc/t3code/managed-settings.json`
 *
 * Policy is read once at startup; a change takes effect when the server
 * restarts. A source that exists but cannot be read, cannot be parsed, or
 * holds a key that is unknown, unmanageable, or invalid fails startup: running
 * with part of a policy silently unenforced is worse than not running.
 *
 * @module ManagedSettings
 */
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { deepMerge } from "@t3tools/shared/Struct";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ManagedSettingsPolicy {
  /** Encoded, settings.json-shaped values to enforce. Empty when no policy applies. */
  readonly document: Readonly<Record<string, unknown>>;
  /** Every leaf key path the document sets. Clients lock these. */
  readonly paths: ReadonlyArray<ReadonlyArray<string>>;
}

const EMPTY_MANAGED_SETTINGS: ManagedSettingsPolicy = { document: {}, paths: [] };

/**
 * Defaults to no policy so tests and tools that build settings without a
 * machine policy stay hermetic. The server provides `layer`.
 */
export class ManagedSettings extends Context.Reference<ManagedSettingsPolicy>(
  "t3/managedSettings",
  { defaultValue: () => EMPTY_MANAGED_SETTINGS },
) {}

export class ManagedSettingsError extends Schema.TaggedError<ManagedSettingsError>()(
  "ManagedSettingsError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid managed settings at ${this.path}: ${this.detail}`;
  }
}

export const MANAGED_PREFERENCES_DOMAIN = "com.t3tools.t3code";

export interface ManagedSettingsSource {
  readonly kind: "json" | "plist";
  readonly path: string;
}

/** Policy sources for a platform, lowest precedence first. */
function managedSettingsSources(platform: NodeJS.Platform): ReadonlyArray<ManagedSettingsSource> {
  switch (platform) {
    case "darwin":
      return [
        { kind: "json", path: "/Library/Application Support/T3Code/managed-settings.json" },
        {
          kind: "plist",
          path: `/Library/Managed Preferences/${MANAGED_PREFERENCES_DOMAIN}.plist`,
        },
      ];
    case "linux":
      return [{ kind: "json", path: "/etc/t3code/managed-settings.json" }];
    default:
      return [];
  }
}

const decodeDocumentJson = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeServerSettingsExit = Schema.decodeUnknownExit(ServerSettings);
// OpenTelemetry export URLs are resolved from settings.json at process start,
// before policy loads, and env vars outrank them, so a policy could not
// enforce them.
const UNMANAGEABLE_KEYS: ReadonlySet<string> = new Set(["observability"]);
const ENCODED_DEFAULT_SERVER_SETTINGS = Schema.encodeSync(ServerSettings)(
  DEFAULT_SERVER_SETTINGS,
) as Record<string, unknown>;

/** Leaf key paths a document sets. Arrays are leaves: they replace whole. */
function leafPaths(
  document: Readonly<Record<string, unknown>>,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  return Object.entries(document).flatMap(([key, value]) => {
    const path = [...prefix, key];
    if (value === undefined) return [];
    return P.isObject(value) && !Array.isArray(value)
      ? leafPaths(value as Record<string, unknown>, path)
      : [path];
  });
}

/**
 * Check each top-level key on its own, on top of the defaults, so the error
 * names every bad key rather than the first decode failure.
 */
function validateDocument(
  source: ManagedSettingsSource,
  document: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>, ManagedSettingsError> {
  const problems = Object.entries(document).flatMap(([key, value]) => {
    if (!Object.hasOwn(ServerSettings.fields, key)) return [`unknown key "${key}"`];
    if (UNMANAGEABLE_KEYS.has(key)) return [`"${key}" cannot be managed`];
    const decoded = decodeServerSettingsExit(
      deepMerge(ENCODED_DEFAULT_SERVER_SETTINGS, { [key]: value }),
    );
    return Exit.isSuccess(decoded) ? [] : [`invalid value for "${key}"`];
  });
  return problems.length === 0
    ? Effect.succeed(document)
    : Effect.fail(new ManagedSettingsError({ path: source.path, detail: problems.join(", ") }));
}

const readSourceText = Effect.fn("ManagedSettings.readSourceText")(function* (
  source: ManagedSettingsSource,
) {
  if (source.kind === "json") {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(source.path);
  }
  // Configuration profiles usually install binary plists; plutil converts
  // any plist flavor to JSON.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make("/usr/bin/plutil", ["-convert", "json", "-o", "-", source.path], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.timeout("5 seconds"));
});

const readSource = Effect.fn("ManagedSettings.readSource")(function* (
  source: ManagedSettingsSource,
) {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = (detail: string) => (cause: unknown) =>
    new ManagedSettingsError({ path: source.path, detail, cause });
  const exists = yield* fs
    .exists(source.path)
    .pipe(Effect.mapError(unreadable("could not check whether it exists")));
  if (!exists) return {};
  const document = yield* readSourceText(source).pipe(
    Effect.mapError(unreadable("could not be read")),
    Effect.flatMap((text) =>
      decodeDocumentJson(text).pipe(Effect.mapError(unreadable("not a JSON object"))),
    ),
  );
  return yield* validateDocument(source, document);
});

/** Merge validated documents, lowest precedence first, into one policy. */
function makeManagedSettingsPolicy(
  documents: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ManagedSettingsPolicy {
  const document = documents.reduce<Record<string, unknown>>(
    (merged, next) => deepMerge(merged, next),
    {},
  );
  return { document, paths: leafPaths(document) };
}

export const loadManagedSettings = Effect.fn("ManagedSettings.load")(function* (
  sources: ReadonlyArray<ManagedSettingsSource>,
) {
  const documents = yield* Effect.forEach(sources, readSource);
  const policy = makeManagedSettingsPolicy(documents);
  if (policy.paths.length > 0) {
    yield* Effect.logInfo("applying managed settings", {
      sources: sources.flatMap((source, index) =>
        Object.keys(documents[index] ?? {}).length > 0 ? [source.path] : [],
      ),
      keys: policy.paths.map((path) => path.join(".")),
    });
  }
  return policy;
});

export const layer = Layer.effect(
  ManagedSettings,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* loadManagedSettings(managedSettingsSources(platform));
  }),
);

/** A fixed policy, validated the same way as a deployed document. */
export const layerTest = (document: Readonly<Record<string, unknown>>) =>
  Layer.effect(
    ManagedSettings,
    validateDocument({ kind: "json", path: "<test>" }, document).pipe(
      Effect.map((valid) => makeManagedSettingsPolicy([valid])),
    ),
  );
