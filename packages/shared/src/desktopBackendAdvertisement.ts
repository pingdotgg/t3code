// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  DESKTOP_BACKEND_ADVERTISEMENT_VERSION,
  DesktopBackendAdvertisement,
} from "@t3tools/contracts";
import {
  readAdvertisementFilenames,
  readAdvertisementJson,
  sanitizeAdvertisementId,
  writeAdvertisementJson,
} from "./advertisementFiles.ts";

export const DESKTOP_BACKEND_ADVERTISEMENT_TTL_MS = 30_000;
export const DESKTOP_BACKEND_ADVERTISEMENT_HEARTBEAT_MS = 10_000;
export const DESKTOP_BACKEND_ADVERTISEMENT_CLEANUP_GRACE_MS = 15 * 60_000;
export const DESKTOP_BACKEND_ADVERTISEMENT_CLEANUP_MAX_DELETES = 10;

const ADVERTISEMENT_DIR_PARTS = ["desktop-backends", "advertisements"] as const;
const BACKEND_ID_PATTERN = /^[a-zA-Z0-9._-]+$/u;

export interface CreateDesktopBackendAdvertisementInput {
  readonly backendId: string;
  readonly httpBaseUrl: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
}

export interface ReadDesktopBackendAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
}

export interface DesktopBackendAdvertisementReadResult {
  readonly advertisements: readonly DesktopBackendAdvertisement[];
  readonly malformed: number;
}

export interface CleanupDesktopBackendAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
  readonly maxDeletes?: number;
}

export interface CleanupDesktopBackendAdvertisementsResult {
  readonly deleted: number;
  readonly errors: number;
}

const decodeDesktopBackendAdvertisement = Schema.decodeUnknownSync(DesktopBackendAdvertisement);

export function resolveDesktopBackendAdvertisementDir(t3Home: string): string {
  return NodePath.join(t3Home, ...ADVERTISEMENT_DIR_PARTS);
}

export function resolveDesktopBackendAdvertisementPath(t3Home: string, backendId: string): string {
  return NodePath.join(
    resolveDesktopBackendAdvertisementDir(t3Home),
    `${sanitizeBackendId(backendId)}.json`,
  );
}

export function createDesktopBackendAdvertisement(
  input: CreateDesktopBackendAdvertisementInput,
): DesktopBackendAdvertisement {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (input.ttlMs ?? DESKTOP_BACKEND_ADVERTISEMENT_TTL_MS);
  return {
    version: DESKTOP_BACKEND_ADVERTISEMENT_VERSION,
    backendId: sanitizeBackendId(input.backendId),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    httpBaseUrl: input.httpBaseUrl,
  };
}

export function writeDesktopBackendAdvertisement(input: {
  readonly t3Home: string;
  readonly advertisement: DesktopBackendAdvertisement;
}): void {
  const dir = resolveDesktopBackendAdvertisementDir(input.t3Home);
  const targetPath = resolveDesktopBackendAdvertisementPath(
    input.t3Home,
    input.advertisement.backendId,
  );
  writeAdvertisementJson({
    dir,
    targetPath,
    id: input.advertisement.backendId,
    value: input.advertisement,
  });
}

export function removeDesktopBackendAdvertisement(input: {
  readonly t3Home: string;
  readonly backendId: string;
}): void {
  NodeFS.rmSync(resolveDesktopBackendAdvertisementPath(input.t3Home, input.backendId), {
    force: true,
  });
}

export function readDesktopBackendAdvertisements(
  input: ReadDesktopBackendAdvertisementsInput,
): DesktopBackendAdvertisementReadResult {
  const nowMs = input.nowMs ?? Date.now();
  const dir = resolveDesktopBackendAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  const advertisements: DesktopBackendAdvertisement[] = [];
  let malformed = 0;

  for (const entry of entries) {
    const filePath = NodePath.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeDesktopBackendAdvertisement);
    if (readResult._tag !== "ok") {
      if (readResult._tag === "invalid") {
        malformed += 1;
      }
      continue;
    }
    const advertisement = readResult.value;
    if (isExpired(advertisement, nowMs)) {
      continue;
    }
    advertisements.push(advertisement);
  }

  return {
    advertisements: advertisements.toSorted(compareDesktopBackendAdvertisements),
    malformed,
  };
}

export function cleanupDesktopBackendAdvertisements(
  input: CleanupDesktopBackendAdvertisementsInput,
): CleanupDesktopBackendAdvertisementsResult {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.graceMs ?? DESKTOP_BACKEND_ADVERTISEMENT_CLEANUP_GRACE_MS;
  const maxDeletes = input.maxDeletes ?? DESKTOP_BACKEND_ADVERTISEMENT_CLEANUP_MAX_DELETES;
  const dir = resolveDesktopBackendAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (deleted >= maxDeletes) {
      break;
    }
    const filePath = NodePath.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeDesktopBackendAdvertisement);
    if (readResult._tag !== "ok") {
      continue;
    }
    const advertisement = readResult.value;
    const expiresAtMs = Date.parse(advertisement.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs + graceMs > nowMs) {
      continue;
    }
    try {
      NodeFS.rmSync(filePath, { force: true });
      deleted += 1;
    } catch {
      errors += 1;
    }
  }

  return { deleted, errors };
}

function sanitizeBackendId(backendId: string): string {
  return sanitizeAdvertisementId({
    id: backendId,
    pattern: BACKEND_ID_PATTERN,
    label: "Desktop backend advertisement backendId",
  });
}

function isExpired(advertisement: DesktopBackendAdvertisement, nowMs: number): boolean {
  const expiresAtMs = Date.parse(advertisement.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function compareDesktopBackendAdvertisements(
  left: DesktopBackendAdvertisement,
  right: DesktopBackendAdvertisement,
): number {
  const updatedAtOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedAtOrder !== 0 && Number.isFinite(updatedAtOrder)) {
    return updatedAtOrder;
  }
  return left.backendId.localeCompare(right.backendId);
}
