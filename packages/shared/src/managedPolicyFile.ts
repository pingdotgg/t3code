import { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ManagedPolicyFileError extends Schema.TaggedError<ManagedPolicyFileError>()(
  "ManagedPolicyFileError",
  {
    path: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The managed policy at ${this.path} is invalid: ${this.reason}. T3 Code will not start until an administrator fixes or removes it.`;
  }
}

/** The system path an administrator deploys the policy to on `platform`. */
export function managedPolicyPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/T3Code/policy.json";
    case "win32":
      // Not ProgramData, where a user can create the folder first and own it; and not
      // %ProgramFiles%, which a user can point somewhere they write.
      return "C:\\Program Files\\T3Code\\policy.json";
    default:
      return "/etc/t3code/policy.json";
  }
}

// Unknown keys may be restrictions from a newer release; refusing them keeps a file this
// build cannot fully enforce from looking enforced.
const decodeDocumentJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(ManagedPolicyDocument),
  { onExcessProperty: "error" },
);
const decodeDocumentExit = Schema.decodeUnknownExit(ManagedPolicyDocument, {
  onExcessProperty: "error",
});

/** Decode a policy from JSON text, or from a value a profile already parsed. */
const decodeDocument = (path: string, raw: unknown) => {
  const decoded = typeof raw === "string" ? decodeDocumentJsonExit(raw) : decodeDocumentExit(raw);
  if (Exit.isSuccess(decoded)) return Effect.succeed(decoded.value);
  const error = Cause.squash(decoded.cause);
  // The schema message names the offending key, e.g. `Expected no excess property at ["limits"]`.
  const detail = Schema.isSchemaError(error) ? ` (${error.message.replace(/\s*\n\s*/g, " ")})` : "";
  return Effect.fail(
    new ManagedPolicyFileError({
      path,
      reason: `it is not valid JSON or does not match the policy schema${detail}`,
      cause: decoded.cause,
    }),
  );
};

/** Read the policy document at `path`; a missing file means no policy. */
export const readManagedPolicyFile = Effect.fn("readManagedPolicyFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(path)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({ path, reason: "the file cannot be checked", cause }),
      ),
    );
  if (!exists) return undefined;
  const raw = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new ManagedPolicyFileError({ path, reason: "the file cannot be read", cause }),
      ),
    );
  return yield* decodeDocument(path, raw);
});

/** Where a configuration profile's managed preferences land on macOS. */
export const MACOS_MANAGED_PREFERENCES_PATH =
  "/Library/Managed Preferences/com.t3tools.t3code.plist";
/** The registry key Group Policy and Intune write to on Windows; `Policy` holds the JSON. */
export const WINDOWS_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\T3Tools\\T3Code";
const WINDOWS_POLICIES_ROOT = "HKLM\\SOFTWARE\\Policies";
// Absolute paths: an earlier PATH entry could otherwise answer that there is no policy.
const PLUTIL = "/usr/bin/plutil";
const REG = "C:\\Windows\\System32\\reg.exe";

// A hung query must not hang startup; a timeout reads as a failed query.
const run = Effect.fnUntraced(
  function* (command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: 2 },
    );
    return { stdout, exitCode: Number(exitCode) };
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(10)),
);

/** The JSON in `reg query` output for the `Policy` value, or undefined when it has none. */
function parseRegistryPolicy(output: string): string | undefined {
  const match = /^\s*Policy\s+REG_SZ\s+(.*?)\s*$/m.exec(output);
  return match?.[1];
}

const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
// Strict: keys beside the wrapper, or more than one entry, decode as a plain document and fail.
const decodeForcedExit = Schema.decodeUnknownExit(
  Schema.Struct({
    Forced: Schema.Tuple([Schema.Struct({ mcx_preference_settings: Schema.Unknown })]),
  }),
  { onExcessProperty: "error" },
);

// macOS writes `PayloadUUID` and `_manualProfile` beside the profile's own keys; no policy key
// starts with `Payload` or `_`, so dropping them cannot hide a restriction.
const withoutProfileKeys = (value: unknown) =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? value
    : Object.fromEntries(
        Object.entries(value).filter(([key]) => !key.startsWith("Payload") && !key.startsWith("_")),
      );

/**
 * Installed managed preferences hold the profile's keys directly, but MCX-style profiles keep
 * them under `Forced[0].mcx_preference_settings`; read either rather than refuse a valid profile.
 */
function unwrapForced(json: string): unknown {
  const parsed = decodeJsonExit(json);
  if (Exit.isFailure(parsed)) return json;
  const preferences = withoutProfileKeys(parsed.value);
  const forced = decodeForcedExit(preferences);
  return Exit.isSuccess(forced)
    ? withoutProfileKeys(forced.value.Forced[0].mcx_preference_settings)
    : preferences;
}

/** Read the policy a configuration profile or Group Policy set; absent means no such policy. */
const readPlatformPolicy = Effect.fnUntraced(function* (platform: NodeJS.Platform) {
  if (platform === "darwin") {
    const path = MACOS_MANAGED_PREFERENCES_PATH;
    const exists = yield* (yield* FileSystem.FileSystem)
      .exists(path)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPolicyFileError({ path, reason: "the profile cannot be checked", cause }),
        ),
      );
    if (!exists) return undefined;
    const converted = yield* run(PLUTIL, ["-convert", "json", "-o", "-", path]).pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({ path, reason: "the profile cannot be read", cause }),
      ),
    );
    if (converted.exitCode !== 0) {
      return yield* new ManagedPolicyFileError({ path, reason: "the profile cannot be read" });
    }
    return { source: path, document: yield* decodeDocument(path, unwrapForced(converted.stdout)) };
  }
  if (platform === "win32") {
    const path = WINDOWS_POLICY_KEY;
    const query = (args: ReadonlyArray<string>) =>
      run(REG, ["query", ...args, "/reg:64"]).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPolicyFileError({ path, reason: "the registry cannot be read", cause }),
        ),
      );
    // reg exits 1 both for a missing value and for a failed query. The Policies key exists on
    // every Windows install, so reading it first separates the two. When reg cannot read even
    // that, as where registry tools are blocked, only the policy file can apply.
    const root = yield* query([WINDOWS_POLICIES_ROOT]).pipe(Effect.option);
    if (Option.isNone(root) || root.value.exitCode !== 0) {
      yield* Effect.logWarning(
        "The Windows registry cannot be read; only the policy file applies.",
      );
      return undefined;
    }
    const queried = yield* query([path, "/v", "Policy"]);
    if (queried.exitCode === 1) return undefined;
    const raw = parseRegistryPolicy(queried.stdout);
    if (queried.exitCode !== 0 || raw === undefined) {
      return yield* new ManagedPolicyFileError({
        path,
        reason: "its Policy value cannot be read as a string",
      });
    }
    return { source: path, document: yield* decodeDocument(path, raw) };
  }
  return undefined;
});

/**
 * Read the machine's policy from wherever an administrator put it: a configuration profile on
 * macOS, the Policies registry key on Windows, or the policy file. Two sources are refused rather
 * than merged, so what applies is never a mix nobody wrote.
 */
export const readManagedPolicy = Effect.fn("readManagedPolicy")(function* (
  platform: NodeJS.Platform,
) {
  const filePath = managedPolicyPath(platform);
  const [platformPolicy, file] = yield* Effect.all([
    readPlatformPolicy(platform),
    readManagedPolicyFile(filePath),
  ]);
  if (platformPolicy !== undefined && file !== undefined) {
    return yield* new ManagedPolicyFileError({
      path: platformPolicy.source,
      reason: `a policy file at ${filePath} also exists; deploy the policy one way`,
    });
  }
  return platformPolicy ?? (file === undefined ? undefined : { source: filePath, document: file });
});
