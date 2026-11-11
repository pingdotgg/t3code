import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";

// Protocol 4 requires coordinated selection writes and unit reconciliation. An
// installed protocol-3 launcher needs one local update or service install with a restart:
// remote updates replace its child, so cannot add these launcher guarantees.
export const SERVICE_LAUNCHER_PROTOCOL = 4 as const;
export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
export const SERVICE_ENV_FILE = "service.env";
export const SERVICE_STATE_FILE = "service-state.json";
/** Set by the unit or launch agent to its own file name, so the launcher can
    find the definition that started it. */
export const SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
/** Written before explicit stop to distinguish shutdown from update handoff. */
export const SERVICE_STOP_MARKER_FILE = ".service-stopping";
/** Marks a repointed unit whose service still runs the old version; launcher startup clears it. */
export const SERVICE_RESTART_PENDING_FILE = ".restart-pending";
/** Durable record of the last server-owner lock holder and whether it was a managed update trial. */
export const SERVER_OWNER_LEASE_FILE = ".server-owner-lease.json";

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  amp: "&",
};

const unescapeXmlText = (value: string) =>
  value.replaceAll(
    /&(?:(quot|apos|lt|gt|amp)|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, named?: string, dec?: string, hex?: string) => {
      if (named !== undefined) return XML_NAMED_ENTITIES[named] ?? match;
      const codePoint =
        dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    },
  );

// Task Scheduler passes `<Exec>` fields through `ExpandEnvironmentStringsW` with no escape syntax.
export const hasWindowsTaskEnvironmentExpansion = (value: string): boolean =>
  /%[^%\r\n]+%/.test(value);

function parseWindowsCommandLine(commandLine: string): ReadonlyArray<string> {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index]!)) {
      index += 1;
    }
    if (index >= commandLine.length) break;
    let current = "";
    let inQuotes = false;
    while (index < commandLine.length) {
      const char = commandLine[index]!;
      if (char === "\\") {
        let slashes = 0;
        while (index < commandLine.length && commandLine[index] === "\\") {
          slashes += 1;
          index += 1;
        }
        if (commandLine[index] === '"') {
          current += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 0) {
            if (inQuotes && commandLine[index + 1] === '"') {
              current += '"';
              index += 2;
            } else {
              inQuotes = !inQuotes;
              index += 1;
            }
          } else {
            current += '"';
            index += 1;
          }
        } else {
          current += "\\".repeat(slashes);
        }
        continue;
      }
      if (char === '"') {
        if (inQuotes && commandLine[index + 1] === '"') {
          current += '"';
          index += 2;
        } else {
          inQuotes = !inQuotes;
          index += 1;
        }
        continue;
      }
      if (!inQuotes && /\s/.test(char)) break;
      current += char;
      index += 1;
    }
    args.push(current);
  }
  return args;
}

function readTaskArguments(contents: string): ReadonlyArray<string> | undefined {
  const actionsScope = /<Actions\b[^>]*>([\s\S]*?)<\/Actions>/i.exec(contents)?.[1] ?? contents;
  const match = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(actionsScope)?.[1];
  return match === undefined ? undefined : parseWindowsCommandLine(unescapeXmlText(match));
}

export function serviceUnitBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=T3CODE_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = /<key>T3CODE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  if (plist !== undefined) return unescapeXmlText(plist);
  const taskArgs = readTaskArguments(contents);
  if (taskArgs === undefined) return undefined;
  const flagIndex = taskArgs.indexOf("--base-dir");
  const rawBaseDir =
    flagIndex >= 0 && flagIndex + 1 < taskArgs.length
      ? taskArgs[flagIndex + 1]
      : taskArgs.find((arg) => arg.startsWith("--base-dir="))?.slice("--base-dir=".length);
  return rawBaseDir !== undefined && !hasWindowsTaskEnvironmentExpansion(rawBaseDir)
    ? rawBaseDir
    : undefined;
}

/** The executable an installed unit, plist, or task starts: the launcher's runtime. */
export function serviceUnitProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  if (plist !== undefined) return unescapeXmlText(plist);
  const taskArgs = readTaskArguments(contents);
  if (taskArgs === undefined) return undefined;
  const headlessIndex = taskArgs.indexOf("--headless");
  const program = headlessIndex >= 0 ? taskArgs[headlessIndex + 1] : undefined;
  return program !== undefined && !hasWindowsTaskEnvironmentExpansion(program)
    ? program
    : undefined;
}

export interface PendingServiceUpdate {
  readonly id: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly dbPath: string;
  readonly status: "pending";
}

export type ServiceUpdateRecord = PendingServiceUpdate | ServerSelfUpdateOutcome;

export interface ServiceState {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly activeVersion: string;
  readonly update?: ServiceUpdateRecord;
}

export interface ServiceLauncherContext {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly childVersion: string;
  readonly update?: ServiceUpdateRecord;
}

export type ServiceLauncherChildMessage =
  | {
      readonly type: "request-update";
      readonly targetVersion: string;
      readonly dbPath: string;
    }
  | {
      readonly type: "prepared";
      readonly updateId: string;
    };

export type ServiceLauncherParentMessage =
  | {
      readonly type: "update-accepted";
      readonly updateId: string;
    }
  | {
      readonly type: "update-rejected";
      readonly reason: string;
    }
  | {
      readonly type: "committed";
      readonly updateId: string;
    }
  | {
      /** Shut down as on SIGTERM, which Windows cannot deliver. */
      readonly type: "stop";
    };

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_SERVICE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export const isExactServiceVersion = (version: string): boolean =>
  EXACT_SERVICE_VERSION.test(version);

export const isValidServiceUpdateId = (id: string): boolean =>
  /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";

const isAbsoluteServiceDatabasePath = (dbPath: string): boolean =>
  !dbPath.includes("\0") && (dbPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dbPath));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeServiceUpdate(value: unknown): ServiceUpdateRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { id, fromVersion, targetVersion, status } = value;
  if (
    typeof id !== "string" ||
    !isValidServiceUpdateId(id) ||
    typeof fromVersion !== "string" ||
    !isExactServiceVersion(fromVersion) ||
    typeof targetVersion !== "string" ||
    !isExactServiceVersion(targetVersion)
  ) {
    return undefined;
  }
  if (status === "pending") {
    return typeof value.dbPath === "string" && isAbsoluteServiceDatabasePath(value.dbPath)
      ? { id, fromVersion, targetVersion, dbPath: value.dbPath, status }
      : undefined;
  }
  if (
    (status === "committed" || status === "rolled-back" || status === "failed") &&
    (value.reason === undefined || (typeof value.reason === "string" && value.reason.trim() !== ""))
  ) {
    return {
      id,
      fromVersion,
      targetVersion,
      status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  return undefined;
}

export function compareExactServiceVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const withoutBuild = version.split("+", 1)[0] ?? version;
    const separator = withoutBuild.indexOf("-");
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
    const [major = "0", minor = "0", patch = "0"] = core.split(".");
    return {
      core: [BigInt(major), BigInt(minor), BigInt(patch)] as const,
      prerelease: prerelease?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function decodeServiceState(value: unknown): ServiceState | undefined {
  if (!isRecord(value)) return undefined;
  const update = value.update === undefined ? undefined : decodeServiceUpdate(value.update);
  if (
    // Protocol 3 has the same durable format; its installer can select a protocol-4 runtime.
    (value.protocol !== 3 && value.protocol !== SERVICE_LAUNCHER_PROTOCOL) ||
    typeof value.activeVersion !== "string" ||
    !isExactServiceVersion(value.activeVersion) ||
    (value.update !== undefined && update === undefined) ||
    (update !== undefined &&
      compareExactServiceVersions(update.targetVersion, update.fromVersion) <= 0) ||
    (update?.status === "pending" && update.fromVersion !== value.activeVersion) ||
    (update?.status === "committed" && update.targetVersion !== value.activeVersion) ||
    ((update?.status === "rolled-back" || update?.status === "failed") &&
      update.fromVersion !== value.activeVersion)
  ) {
    return undefined;
  }
  return {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: value.activeVersion,
    ...(update === undefined ? {} : { update }),
  };
}

export function parseServiceState(value: string): ServiceState | undefined {
  try {
    return decodeServiceState(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function serviceStateHasPendingUpdate(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && isRecord(parsed.update) && parsed.update.status === "pending";
  } catch {
    return false;
  }
}

export function serviceStateActiveVersion(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      typeof parsed.activeVersion === "string" &&
      isExactServiceVersion(parsed.activeVersion)
      ? parsed.activeVersion
      : undefined;
  } catch {
    return undefined;
  }
}

export function decodeServiceLauncherContext(value: string): ServiceLauncherContext | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
    typeof parsed.childVersion !== "string" ||
    !isExactServiceVersion(parsed.childVersion)
  ) {
    return undefined;
  }
  const update = parsed.update === undefined ? undefined : decodeServiceUpdate(parsed.update);
  if (parsed.update !== undefined && update === undefined) return undefined;
  const selectedVersion =
    update?.status === "pending" || update?.status === "committed"
      ? update.targetVersion
      : update === undefined
        ? parsed.childVersion
        : update.fromVersion;
  if (parsed.childVersion !== selectedVersion) {
    return undefined;
  }
  return {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion: parsed.childVersion,
    ...(update === undefined ? {} : { update }),
  };
}

export function decodeServiceLauncherChildMessage(
  value: unknown,
): ServiceLauncherChildMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "request-update" &&
    typeof value.targetVersion === "string" &&
    typeof value.dbPath === "string"
  ) {
    return { type: value.type, targetVersion: value.targetVersion, dbPath: value.dbPath };
  }
  return value.type === "prepared" && typeof value.updateId === "string"
    ? { type: value.type, updateId: value.updateId }
    : undefined;
}

export function decodeServiceLauncherParentMessage(
  value: unknown,
): ServiceLauncherParentMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "update-rejected" && typeof value.reason === "string") {
    return { type: value.type, reason: value.reason };
  }
  if (value.type === "update-accepted" && typeof value.updateId === "string") {
    return { type: value.type, updateId: value.updateId };
  }
  if (value.type === "stop") return { type: value.type };
  return value.type === "committed" && typeof value.updateId === "string"
    ? { type: value.type, updateId: value.updateId }
    : undefined;
}
