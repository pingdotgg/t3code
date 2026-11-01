import { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";

export class ManagedPolicyFileError extends Schema.TaggedError<ManagedPolicyFileError>()(
  "ManagedPolicyFileError",
  {
    path: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `T3 Code cannot use the managed policy at ${this.path}: ${this.reason}. It will not start until an administrator fixes this.`;
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
const WINDOWS_POLICY_SUBKEY = "SOFTWARE\\Policies\\T3Tools\\T3Code";
/** The registry key Group Policy and Intune write to on Windows; `Policy` holds the JSON. */
export const WINDOWS_POLICY_KEY = `HKLM\\${WINDOWS_POLICY_SUBKEY}`;
// An absolute path: an earlier PATH entry could otherwise answer that there is no policy.
const PLUTIL = "/usr/bin/plutil";

export class WindowsRegistryError extends Schema.TaggedError<WindowsRegistryError>()(
  "WindowsRegistryError",
  {
    /** The Win32 error, such as 5 for access denied; absent when the registry API cannot load. */
    code: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.code === undefined ? "the registry API cannot load" : `Windows error ${this.code}`;
  }
}

/**
 * Reads the registry through the Win32 API in this process. A missing value and a failed read
 * come back apart, and blocked registry tools such as reg.exe do not matter.
 */
export class WindowsRegistry extends Context.Service<
  WindowsRegistry,
  {
    /** The REG_SZ `value` of HKLM\\`subkey` in the 64-bit view; undefined when either is absent. */
    readonly readMachineString: (
      subkey: string,
      value: string,
    ) => Effect.Effect<string | undefined, WindowsRegistryError>;
  }
>()("@t3tools/shared/managedPolicyFile/WindowsRegistry") {}

// (HKEY)(LONG)0x80000002, sign-extended to 64 bits.
const HKEY_LOCAL_MACHINE = -0x7ffffffen;
const RRF_RT_REG_SZ = 0x2;
const RRF_SUBKEY_WOW6464KEY = 0x10000;
// Without it a REG_EXPAND_SZ value passes as REG_SZ, with the user's variables filled in.
const RRF_NOEXPAND = 0x10000000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_MORE_DATA = 234;
const ERROR_UNSUPPORTED_TYPE = 1630;

/**
 * Each app passes how it loads ffi-rs: a server single-executable resolves packages on disk only
 * through `require`, and the desktop's CommonJS bundle loads them with `import()`.
 */
export const layerWindowsRegistry = (loadFfi: () => Promise<typeof import("ffi-rs")>) =>
  Layer.effect(
    WindowsRegistry,
    Effect.gen(function* () {
      const architecture = yield* HostProcess.Architecture;
      const loadGetValue = yield* Effect.cached(
        Effect.tryPromise({
          try: async () => {
            // HKEY_LOCAL_MACHINE and the pointer arguments below are 64-bit.
            if (architecture !== "x64" && architecture !== "arm64") {
              throw new Error(`no registry access on ${architecture}`);
            }
            const { DataType, load, open } = await loadFfi();
            open({ library: "t3-advapi32", path: "advapi32.dll" });
            return (subkey: string, value: string, data: Buffer, size: Buffer): number =>
              load({
                library: "t3-advapi32",
                funcName: "RegGetValueW",
                retType: DataType.I32,
                paramsType: [
                  DataType.BigInt,
                  DataType.WString,
                  DataType.WString,
                  DataType.U32,
                  DataType.BigInt,
                  DataType.U8Array,
                  DataType.U8Array,
                ],
                paramsValue: [
                  HKEY_LOCAL_MACHINE,
                  subkey,
                  value,
                  RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY | RRF_NOEXPAND,
                  0n,
                  data,
                  size,
                ],
              });
          },
          catch: (cause) => new WindowsRegistryError({ cause }),
        }),
      );
      return WindowsRegistry.of({
        readMachineString: Effect.fn("WindowsRegistry.readMachineString")(
          function* (subkey, value) {
            const getValue = yield* loadGetValue;
            const attempt = (bytes: number) =>
              Effect.try({
                try: () => {
                  const data = Buffer.alloc(bytes);
                  const size = Buffer.alloc(4);
                  size.writeUInt32LE(bytes);
                  const code = getValue(subkey, value, data, size);
                  return { code, data, bytes: size.readUInt32LE() };
                },
                catch: (cause) => new WindowsRegistryError({ cause }),
              });
            let result = yield* attempt(64 * 1024);
            // The value grew past the buffer; the API reported the size it needs.
            if (result.code === ERROR_MORE_DATA) result = yield* attempt(result.bytes);
            if (result.code === ERROR_FILE_NOT_FOUND) return undefined;
            if (result.code !== 0) return yield* new WindowsRegistryError({ code: result.code });
            // The size counts the terminating null RegGetValueW adds.
            return result.data.subarray(0, result.bytes).toString("utf16le").replace(/\0+$/, "");
          },
        ),
      });
    }),
  );

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
    const raw = yield* (yield* WindowsRegistry)
      .readMachineString(WINDOWS_POLICY_SUBKEY, "Policy")
      .pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPolicyFileError({
              path,
              reason:
                cause.code === ERROR_UNSUPPORTED_TYPE
                  ? "its Policy value is not a string (REG_SZ)"
                  : cause.code === undefined
                    ? "this T3 Code install cannot load its registry reader; reinstall T3 Code"
                    : `the registry cannot be read (${cause.message})`,
              cause,
            }),
        ),
      );
    return raw === undefined
      ? undefined
      : { source: path, document: yield* decodeDocument(path, raw) };
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
