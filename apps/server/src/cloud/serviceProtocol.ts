import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";

/** Protocol 2 snapshots SQLite before trials so migrations can be rolled back safely. */
export const SERVICE_LAUNCHER_PROTOCOL = 2 as const;
export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
export const SERVICE_LAUNCHER_FILE = "service-launcher.mjs";
export const SERVICE_STATE_FILE = "service-state.json";

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

/** Context is copied from launcher-owned state when a child is spawned. */
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
    };

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_SERVICE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/** Accepts exact SemVer only: never dist-tags or ranges passed to npm or filesystem paths. */
export const isExactServiceVersion = (version: string): boolean =>
  EXACT_SERVICE_VERSION.test(version);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeServiceUpdate(value: unknown): ServiceUpdateRecord | undefined {
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

/** SemVer precedence for exact versions. Build metadata is ignored. */
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
    value.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
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

/** Detects an in-flight update across launcher protocol versions before replacing its state. */
export function serviceStateHasPendingUpdate(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && isRecord(parsed.update) && parsed.update.status === "pending";
  } catch {
    return false;
  }
}

/** Reads the active version across launcher protocol revisions for downgrade protection. */
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
  return value.type === "committed" && typeof value.updateId === "string"
    ? { type: value.type, updateId: value.updateId }
    : undefined;
}
