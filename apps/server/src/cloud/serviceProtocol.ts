import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";

// Protocol 4 launchers coordinate selection writes and reconcile the unit. A remote update
// replaces only the child, so an installed protocol-3 launcher stays until a local update or
// service install restarts the service.
export const SERVICE_LAUNCHER_PROTOCOL = 4 as const;
/** Launchers this runtime runs under. Protocol 3 has the same IPC and durable format, and
    refusing it stops every remote update until someone opens a shell on the host. */
export type SupportedLauncherProtocol = 3 | typeof SERVICE_LAUNCHER_PROTOCOL;
export const isSupportedLauncherProtocol = (
  protocol: unknown,
): protocol is SupportedLauncherProtocol =>
  protocol === 3 || protocol === SERVICE_LAUNCHER_PROTOCOL;
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
/** Held by a Windows launcher while it runs: Task Scheduler tracks only the task's console host. */
export const SERVICE_LAUNCHER_LOCK_FILE = "service-launcher.lock";
/** Held by a launcher while it has, or is about to start, a server: an SSH launch waits for that
    server instead of starting its own. Released while the launcher idles. */
export const SERVICE_SERVING_LOCK_FILE = "service-serving.lock";

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const unquoteWindowsArgument = (raw: string) =>
  unescapeXmlText(raw).replace(/(\\+)$/, (slashes) => slashes.slice(slashes.length / 2));

/** Whether Task Scheduler's copy of a task is disabled as a whole, not one of its triggers. */
export const serviceTaskIsDisabled = (taskXml: string): boolean =>
  /<Settings>[\s\S]*?<\/Settings>/.exec(taskXml)?.[0].includes("<Enabled>false</Enabled>") === true;

/** A task as Task Scheduler should hold it while its service must stay stopped. */
export const disabledServiceTask = (taskXml: string): string =>
  serviceTaskIsDisabled(taskXml)
    ? taskXml
    : taskXml.replace("  </Settings>", "    <Enabled>false</Enabled>\n  </Settings>");

export function serviceUnitEnvironmentValueOf(
  contents: string,
  name: "T3CODE_HOME" | "T3CODE_INSTALL_BIN_DIR",
): string | undefined {
  const systemd = new RegExp(`^Environment=${name}=(.*)$`, "m").exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(contents)?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

export function serviceUnitBaseDirOf(contents: string): string | undefined {
  const unix = serviceUnitEnvironmentValueOf(contents, "T3CODE_HOME");
  if (unix !== undefined) return unix;
  const task = /<Arguments>[^<]* "--base-dir" "([^"]*)"/.exec(contents)?.[1];
  return task === undefined ? undefined : unquoteWindowsArgument(task);
}

/**
 * The user unit directory a systemd manager reads, from its UnitPath property. The persistent
 * control directory identifies the manager's config root despite UnitPath overrides.
 */
export function systemdUnitDirectoryOf(unitPath: ReadonlyArray<string>): string | undefined {
  const controlDirectory = unitPath.find(
    (directory) =>
      directory.startsWith("/") &&
      directory.endsWith("/systemd/user.control") &&
      unitPath.includes(directory.slice(0, -".control".length)),
  );
  return controlDirectory?.slice(0, -".control".length);
}

/** The file systemd or launchd appends the service's output to. */
export function serviceUnitLogPathOf(contents: string): string | undefined {
  const systemd = /^StandardOutput=append:(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

/** The executable an installed unit, plist, or task starts: the launcher's runtime. */
export function serviceUnitProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  if (plist !== undefined) return unescapeXmlText(plist);
  const task = /<Arguments>--headless "([^"]*)"/.exec(contents)?.[1];
  return task === undefined ? undefined : unquoteWindowsArgument(task);
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
  readonly protocol: SupportedLauncherProtocol;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeServiceUpdate(value: unknown): ServiceUpdateRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { id, fromVersion, targetVersion, status } = value;
  if (
    typeof id !== "string" ||
    id.trim() === "" ||
    typeof fromVersion !== "string" ||
    !isExactServiceVersion(fromVersion) ||
    typeof targetVersion !== "string" ||
    !isExactServiceVersion(targetVersion)
  ) {
    return undefined;
  }
  if (status === "pending") {
    return typeof value.dbPath === "string" && value.dbPath.trim() !== ""
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
    // A protocol-3 installer can select a protocol-4 runtime.
    !isSupportedLauncherProtocol(value.protocol) ||
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

export function parseLegacyServiceState(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).length !== 2 ||
      parsed.protocol !== 2 ||
      typeof parsed.activeVersion !== "string" ||
      !isExactServiceVersion(parsed.activeVersion)
    ) {
      return undefined;
    }
    return { protocol: 2, activeVersion: parsed.activeVersion } as const;
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
    !isSupportedLauncherProtocol(parsed.protocol) ||
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
    protocol: parsed.protocol,
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
