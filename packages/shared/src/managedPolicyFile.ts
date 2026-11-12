import {
  ManagedPolicyClient,
  ManagedPolicyDocument,
  SERVER_EXIT_CODE_MANAGED_POLICY,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
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
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_MANAGED_POLICY;

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
/**
 * The registry key Group Policy and Intune write to on Windows. It holds either the Group Policy
 * template's values, one per control, or a `Policy` string with the whole policy as JSON.
 */
export const WINDOWS_POLICY_KEY = `HKLM\\${WINDOWS_POLICY_SUBKEY}`;

/** Each value a Group Policy control writes, and where it lands in the document. */
export const WINDOWS_POLICY_VALUES = {
  Organization: { type: "string", path: ["organization"] },
  SupportUrl: { type: "string", path: ["supportUrl"] },
  Settings: { type: "json", path: ["settings"] },
  MaxRuntimeMode: { type: "string", path: ["limits", "maxRuntimeMode"] },
  Connect: { type: "boolean", path: ["limits", "connect"] },
  WebhookTasks: { type: "boolean", path: ["limits", "webhookTasks"] },
  Telemetry: { type: "boolean", path: ["limits", "telemetry"] },
  BrowserCookieImport: { type: "boolean", path: ["limits", "browserCookieImport"] },
  ProviderInstances: { type: "json", path: ["limits", "providers", "instances"] },
  UpdatesMode: { type: "string", path: ["limits", "updates", "mode"] },
  UpdatesFeedUrl: { type: "string", path: ["limits", "updates", "feedUrl"] },
  AllowNightly: { type: "boolean", path: ["limits", "updates", "allowNightly"] },
} as const satisfies Record<
  string,
  { readonly type: "string" | "json" | "boolean"; readonly path: ReadonlyArray<string> }
>;

/** Subkeys of checkboxes: every value set to 1 is one entry of the list at `path`. */
export const WINDOWS_POLICY_LISTS = {
  Clients: ["limits", "clients"],
  AllowedDrivers: ["limits", "providers", "allowedDrivers"],
} as const satisfies Record<string, ReadonlyArray<string>>;
// A disabled policy still writes its checkboxes' falseValue; its own DWORD disambiguates it.
export const WINDOWS_POLICY_GROUPS = {
  ...WINDOWS_POLICY_LISTS,
  Updates: ["limits", "updates"],
} as const satisfies Record<string, ReadonlyArray<string>>;
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

/** A registry value; REG_EXPAND_SZ and every other type read as `other`. */
export type RegistryValue =
  | { readonly name: string; readonly type: "REG_SZ"; readonly data: string }
  | { readonly name: string; readonly type: "REG_DWORD"; readonly data: number }
  | { readonly name: string; readonly type: "other" };

export interface RegistryKey {
  readonly values: ReadonlyArray<RegistryValue>;
  readonly subkeys: ReadonlyArray<string>;
}

/**
 * Reads the registry through the Win32 API in this process. A missing key and a failed read come
 * back apart, and blocked registry tools such as reg.exe do not matter.
 */
export class WindowsRegistry extends Context.Service<
  WindowsRegistry,
  {
    /** The values and subkey names of HKLM\\`subkey` in the 64-bit view; undefined when absent. */
    readonly readMachineKey: (
      subkey: string,
    ) => Effect.Effect<RegistryKey | undefined, WindowsRegistryError>;
  }
>()("@t3tools/shared/managedPolicyFile/WindowsRegistry") {}

// (HKEY)(LONG)0x80000002, sign-extended to 64 bits.
const HKEY_LOCAL_MACHINE = -0x7ffffffen;
const KEY_READ = 0x20019;
const KEY_WOW64_64KEY = 0x100;
const REG_SZ = 1;
const REG_DWORD = 4;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
// Value and key names are at most 16,383 characters.
const MAX_NAME_CHARS = 16_384;

class Win32Failure extends Schema.TaggedError<Win32Failure>()("Win32Failure", {
  code: Schema.Number,
}) {
  override get message(): string {
    return `Windows error ${this.code}`;
  }
}

const isWin32Failure = Schema.is(Win32Failure);

/**
 * Each app passes how it loads ffi-rs: a server single-executable resolves packages on disk only
 * through `require`, and the desktop's CommonJS bundle loads them with `import()`.
 */
export const layerWindowsRegistry = (loadFfi: () => Promise<typeof import("ffi-rs")>) =>
  Layer.effect(
    WindowsRegistry,
    Effect.gen(function* () {
      const architecture = yield* HostProcess.Architecture;
      const loadApi = yield* Effect.cached(
        Effect.tryPromise({
          try: async () => {
            // HKEY_LOCAL_MACHINE, key handles, and the null pointers below are 64-bit.
            if (architecture !== "x64" && architecture !== "arm64") {
              throw new Error(`no registry access on ${architecture}`);
            }
            const { DataType, load, open } = await loadFfi();
            open({ library: "t3-advapi32", path: "advapi32.dll" });
            const call = (
              funcName: string,
              paramsType: Array<(typeof DataType)[keyof typeof DataType]>,
              paramsValue: Array<unknown>,
            ): number =>
              load({
                library: "t3-advapi32",
                funcName,
                retType: DataType.I32,
                paramsType,
                paramsValue,
              } as Parameters<typeof load>[0]) as number;
            const { BigInt: Handle, U32, U8Array: Out, WString } = DataType;
            return {
              open: (subkey: string, handle: Buffer) =>
                call(
                  "RegOpenKeyExW",
                  [Handle, WString, U32, U32, Out],
                  [HKEY_LOCAL_MACHINE, subkey, 0, KEY_READ | KEY_WOW64_64KEY, handle],
                ),
              enumValue: (
                key: bigint,
                index: number,
                name: Buffer,
                nameChars: Buffer,
                type: Buffer,
                data: Buffer,
                dataBytes: Buffer,
              ) =>
                call(
                  "RegEnumValueW",
                  [Handle, U32, Out, Out, Handle, Out, Out, Out],
                  [key, index, name, nameChars, 0n, type, data, dataBytes],
                ),
              enumKey: (key: bigint, index: number, name: Buffer, nameChars: Buffer) =>
                call(
                  "RegEnumKeyExW",
                  [Handle, U32, Out, Out, Handle, Handle, Handle, Handle],
                  [key, index, name, nameChars, 0n, 0n, 0n, 0n],
                ),
              close: (key: bigint) => call("RegCloseKey", [Handle], [key]),
            };
          },
          catch: (cause) => new WindowsRegistryError({ cause }),
        }),
      );

      const readKey = (api: Effect.Success<typeof loadApi>, subkey: string) => {
        const handle = Buffer.alloc(8);
        const opened = api.open(subkey, handle);
        if (opened === ERROR_FILE_NOT_FOUND) return undefined;
        if (opened !== 0) throw new Win32Failure({ code: opened });
        const key = handle.readBigInt64LE();
        try {
          const name = Buffer.alloc(MAX_NAME_CHARS * 2);
          const chars = Buffer.alloc(4);
          const values: Array<RegistryValue> = [];
          for (let index = 0; ; index++) {
            let data = Buffer.alloc(64 * 1024);
            const type = Buffer.alloc(4);
            const bytes = Buffer.alloc(4);
            const attempt = () => {
              chars.writeUInt32LE(MAX_NAME_CHARS);
              bytes.writeUInt32LE(data.length);
              return api.enumValue(key, index, name, chars, type, data, bytes);
            };
            let code = attempt();
            // The value is larger than the buffer; the API reported the size it needs.
            if (code === ERROR_MORE_DATA) {
              data = Buffer.alloc(bytes.readUInt32LE());
              code = attempt();
            }
            if (code === ERROR_NO_MORE_ITEMS) break;
            if (code !== 0) throw new Win32Failure({ code: code });
            const valueName = name.subarray(0, chars.readUInt32LE() * 2).toString("utf16le");
            const stored = data.subarray(0, bytes.readUInt32LE());
            const valueType = type.readUInt32LE();
            values.push(
              valueType === REG_SZ
                ? {
                    name: valueName,
                    type: "REG_SZ",
                    data: stored.toString("utf16le").replace(/\0+$/, ""),
                  }
                : valueType === REG_DWORD && stored.length === 4
                  ? { name: valueName, type: "REG_DWORD", data: stored.readUInt32LE() }
                  : { name: valueName, type: "other" },
            );
          }
          const subkeys: Array<string> = [];
          for (let index = 0; ; index++) {
            chars.writeUInt32LE(MAX_NAME_CHARS);
            const code = api.enumKey(key, index, name, chars);
            if (code === ERROR_NO_MORE_ITEMS) break;
            if (code !== 0) throw new Win32Failure({ code: code });
            subkeys.push(name.subarray(0, chars.readUInt32LE() * 2).toString("utf16le"));
          }
          return { values, subkeys };
        } finally {
          api.close(key);
        }
      };

      return WindowsRegistry.of({
        readMachineKey: Effect.fn("WindowsRegistry.readMachineKey")(function* (subkey) {
          const api = yield* loadApi;
          return yield* Effect.try({
            try: () => readKey(api, subkey),
            catch: (cause) =>
              new WindowsRegistryError(
                isWin32Failure(cause) ? { code: cause.code, cause } : { cause },
              ),
          });
        }),
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
type PolicyRegistryValue = RegistryValue & {
  /** The list subkey the value sits in, or "" for the policy key itself. */
  readonly key: string;
};

const setPath = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown) => {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    node = (node[segment] ??= {}) as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
};

const dwordBoolean = (value: RegistryValue) =>
  value.type !== "REG_DWORD"
    ? undefined
    : value.data === 0
      ? false
      : value.data === 1
        ? true
        : undefined;

/**
 * The document the Group Policy template's values describe, undefined when they describe none, or
 * why they do not describe one.
 */
function windowsPolicyDocument(
  values: ReadonlyArray<PolicyRegistryValue>,
  knownDrivers: ReadonlyArray<string>,
): { readonly document: unknown } | { readonly error: string } {
  // Registry names ignore case; a hand-written `organization` is still Organization.
  const canonical = new Map(
    [...Object.keys(WINDOWS_POLICY_VALUES), ...Object.keys(WINDOWS_POLICY_GROUPS)].map((name) => [
      name.toLowerCase(),
      name,
    ]),
  );
  values = values.map((value) =>
    value.key === ""
      ? { ...value, name: canonical.get(value.name.toLowerCase()) ?? value.name }
      : value,
  );
  const document: Record<string, unknown> = { schemaVersion: 1 };
  const lists = new Map<string, Array<string>>();
  const disabled: Array<ReadonlyArray<string>> = [];
  for (const value of values) {
    if (value.key !== "" || !Object.hasOwn(WINDOWS_POLICY_GROUPS, value.name)) continue;
    const enabled = dwordBoolean(value);
    if (enabled === undefined) return { error: `${value.name} must be a DWORD of 0 or 1` };
    if (!enabled) {
      disabled.push(WINDOWS_POLICY_GROUPS[value.name as keyof typeof WINDOWS_POLICY_GROUPS]);
    } else if (Object.hasOwn(WINDOWS_POLICY_LISTS, value.name)) {
      lists.set(value.name, []);
    }
  }
  const put = (path: ReadonlyArray<string>, value: unknown) => {
    if (!disabled.some((prefix) => prefix.every((segment, index) => path[index] === segment))) {
      setPath(document, path, value);
    }
  };
  for (const value of values) {
    const where = value.key === "" ? value.name : `${value.key}\\${value.name}`;
    if (value.key !== "") {
      const checked = dwordBoolean(value);
      if (checked === undefined) return { error: `${where} must be a DWORD of 0 or 1` };
      const list = lists.get(value.key) ?? [];
      lists.set(value.key, list);
      if (checked) {
        const names = value.key === "Clients" ? ManagedPolicyClient.literals : knownDrivers;
        list.push(
          names.find((name) => name.toLowerCase() === value.name.toLowerCase()) ?? value.name,
        );
      }
      continue;
    }
    if (Object.hasOwn(WINDOWS_POLICY_GROUPS, value.name)) continue;
    if (!Object.hasOwn(WINDOWS_POLICY_VALUES, value.name)) {
      return { error: `${value.name} is not a T3 Code policy value` };
    }
    const field = WINDOWS_POLICY_VALUES[value.name as keyof typeof WINDOWS_POLICY_VALUES];
    if (field.type === "boolean") {
      const flag = dwordBoolean(value);
      if (flag === undefined) return { error: `${where} must be a DWORD of 0 or 1` };
      put(field.path, flag);
      continue;
    }
    if (value.type !== "REG_SZ") return { error: `${where} must be a string (REG_SZ)` };
    // Group Policy writes an empty string for a box left blank.
    if (value.data === "") continue;
    if (field.type === "string") {
      put(field.path, value.data);
      continue;
    }
    const parsed = decodeJsonExit(value.data);
    if (Exit.isFailure(parsed)) return { error: `${where} is not valid JSON` };
    put(field.path, parsed.value);
  }
  for (const [key, list] of lists) {
    put(WINDOWS_POLICY_LISTS[key as keyof typeof WINDOWS_POLICY_LISTS], list);
  }
  // Policies set to Disabled leave values behind that restrict nothing.
  if (Object.keys(document).length === 1) return { document: undefined };
  // The schema would name `["organization"]`, which an admin cannot map to a Group Policy setting.
  if (document.organization === undefined) {
    return { error: "set the Organization policy whenever another T3 Code policy is set" };
  }
  return { document };
}

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
const readPlatformPolicy = Effect.fnUntraced(function* (
  platform: NodeJS.Platform,
  knownDrivers: ReadonlyArray<string>,
) {
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
    const registry = yield* WindowsRegistry;
    const readKey = (subkey: string) =>
      registry.readMachineKey(subkey).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedPolicyFileError({
              path,
              reason:
                cause.code === undefined
                  ? "this T3 Code install cannot load its registry reader; reinstall T3 Code"
                  : `the registry cannot be read (${cause.message})`,
              cause,
            }),
        ),
      );
    const refuse = (reason: string) => new ManagedPolicyFileError({ path, reason });
    const root = yield* readKey(WINDOWS_POLICY_SUBKEY);
    if (root === undefined) return undefined;
    const json = root.values.find((value) => value.name.toLowerCase() === "policy");
    if (json !== undefined) {
      // Not Configured clears a list policy's values but can leave its empty subkey behind.
      let templateSettings = root.values.length > 1;
      for (const subkey of root.subkeys) {
        if (templateSettings) break;
        const child = yield* readKey(`${WINDOWS_POLICY_SUBKEY}\\${subkey}`);
        templateSettings =
          child !== undefined && (child.values.length > 0 || child.subkeys.length > 0);
      }
      if (templateSettings) {
        return yield* refuse(
          "it holds both a Policy value and Group Policy settings; deploy the policy one way",
        );
      }
      if (json.type !== "REG_SZ") return yield* refuse("its Policy value is not a string (REG_SZ)");
      return { source: path, document: yield* decodeDocument(path, json.data) };
    }
    const values: Array<PolicyRegistryValue> = root.values.map((value) => ({ ...value, key: "" }));
    for (const subkey of root.subkeys) {
      // Registry names ignore case.
      const list = Object.keys(WINDOWS_POLICY_LISTS).find(
        (name) => name.toLowerCase() === subkey.toLowerCase(),
      );
      if (list === undefined) return yield* refuse(`${subkey} is not a T3 Code policy key`);
      const checkboxes = yield* readKey(`${WINDOWS_POLICY_SUBKEY}\\${subkey}`);
      if (checkboxes === undefined) continue;
      if (checkboxes.subkeys.length > 0) {
        return yield* refuse(`${subkey}\\${checkboxes.subkeys[0]} is not a T3 Code policy key`);
      }
      values.push(...checkboxes.values.map((value) => ({ ...value, key: list })));
    }
    const built = windowsPolicyDocument(values, knownDrivers);
    if ("error" in built) return yield* refuse(built.error);
    // An empty key, or one holding only policies set to Disabled, sets nothing.
    if (built.document === undefined) return undefined;
    return { source: path, document: yield* decodeDocument(path, built.document) };
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
  knownDrivers: ReadonlyArray<string> = [],
) {
  const filePath = managedPolicyPath(platform);
  const [platformPolicy, file] = yield* Effect.all([
    readPlatformPolicy(platform, knownDrivers),
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
