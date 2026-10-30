import { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
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
      // Not %ProgramData%: users can point that variable somewhere they write.
      return "C:\\ProgramData\\T3Code\\policy.json";
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
/** The registry key the Group Policy template's controls write to, one value each. */
export const WINDOWS_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\T3Tools\\T3Code";

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
// Absolute paths: an earlier PATH entry could otherwise answer that there is no policy.
const PLUTIL = "/usr/bin/plutil";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// Pipe HKLM straight out, since a file in the user's TEMP can be swapped. Cmdlets only: AppLocker
// and WDAC force Constrained Language mode, which blocks RegistryKey and [Console]. Non-ASCII goes
// out as JSON escapes, whatever the code page. The provider expands REG_EXPAND_SZ, which the
// template never writes.
const WINDOWS_POLICY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
  Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
  Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
  $root = $null
  try { $root = Get-Item -LiteralPath '${WINDOWS_POLICY_KEY.replace(/^HKLM\\/, "HKLM:\\")}' } catch {
    if ($_.FullyQualifiedErrorId -notlike 'PathNotFound,*') { throw }
  }
  $values = @(if ($null -ne $root) {
    foreach ($key in @($root) + @(Get-ChildItem -LiteralPath $root.PSPath -Recurse)) {
      $path = $key.Name.Substring($root.Name.Length).TrimStart('\')
      foreach ($name in $key.Property) {
        $data = Get-ItemPropertyValue -LiteralPath $key.PSPath -Name $name
        if ($data -is [string]) { @{ key = $path; name = $name; type = 'REG_SZ'; data = $data } }
        elseif ($data -is [int]) { @{ key = $path; name = $name; type = 'REG_DWORD'; data = '0x{0:x}' -f $data } }
        else { @{ key = $path; name = $name; type = 'other'; data = '' } }
      }
    }
  })
  $json = ConvertTo-Json -InputObject $values -Depth 4 -Compress
  -join @(foreach ($char in $json.ToCharArray()) { if ([int]$char -gt 127) { '\u{0:x4}' -f [int]$char } else { $char } })
} catch { exit 1 }
`;

const run = Effect.fnUntraced(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
    { concurrency: 2 },
  );
  return { stdout, exitCode: Number(exitCode) };
}, Effect.scoped);

const decodeJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const RegistryValue = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["REG_SZ", "REG_DWORD", "other"]),
  data: Schema.String,
});
type RegistryValue = typeof RegistryValue.Type;
const decodeRegistryValues = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(RegistryValue)),
  { onExcessProperty: "error" },
);

const setPath = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown) => {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    node = (node[segment] ??= {}) as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
};

const dwordBoolean = (value: RegistryValue) =>
  value.type !== "REG_DWORD" ? undefined : ({ "0x0": false, "0x1": true } as const)[value.data];

/** The document the template's separate values describe, or why they do not describe one. */
export function windowsPolicyDocument(
  values: ReadonlyArray<RegistryValue>,
): { readonly document: unknown } | { readonly error: string } {
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
      const listKey = Object.keys(WINDOWS_POLICY_LISTS).find(
        (key) => key.toLowerCase() === value.key.toLowerCase(),
      );
      if (listKey === undefined) {
        return { error: `${value.key} is not a T3 Code policy key` };
      }
      const checked = dwordBoolean(value);
      if (checked === undefined) return { error: `${where} must be a DWORD of 0 or 1` };
      const list = lists.get(listKey) ?? [];
      lists.set(listKey, list);
      if (checked) list.push(value.name);
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
    if (value.type !== "REG_SZ") return { error: `${where} must be a string` };
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
  // Disabled groups can leave registry values without an effective policy.
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
    const { stdout, exitCode } = yield* run(POWERSHELL, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_POLICY_SCRIPT,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({ path, reason: "the registry cannot be read", cause }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new ManagedPolicyFileError({ path, reason: "the registry cannot be read" });
    }
    const values = yield* decodeRegistryValues(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ManagedPolicyFileError({
            path,
            reason: "the registry reader returned invalid data",
            cause,
          }),
      ),
    );
    const built = windowsPolicyDocument(values);
    if ("error" in built) {
      return yield* new ManagedPolicyFileError({ path, reason: built.error });
    }
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
