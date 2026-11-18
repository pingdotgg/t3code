import * as Schema from "effect/Schema";
import { PROFILE_SCHEMA_VERSION, isJsonObject, type JsonObject } from "./profileDocument.ts";
import type { ProfileSyncChannel } from "./profileSync.ts";

/**
 * Conn: the profile section that lists threads hidden from the sidebar. Same shape, ref syntax and
 * limits as `attachedThreads`: `{schema: 1, threads: [{environmentId, threadId}]}` or null. Each
 * write replaces the whole set at the section version this device last read.
 */
export const SIDEBAR_HIDDEN_THREADS_SECTION = "sidebarHiddenThreads";

const SIDEBAR_HIDDEN_THREADS_LIMITS = { rows: 500, bytes: 64 * 1024 } as const;

/** What this device wants for one thread, rebased onto the profile's latest set at each write. */
export type SidebarHiddenIntent = "hide" | "show";

/** One unsent intent. `id` changes with every edit, so an acknowledgement retires only what it sent. */
export interface SidebarHiddenOp {
  readonly intent: SidebarHiddenIntent;
  readonly id: string;
}

/** The key of a ref, as `scopedThreadKey` writes it. */
export function sidebarHiddenThreadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/**
 * A ref part the Gateway accepts: 1 to 255 UTF-8 bytes without ASCII whitespace (its PHP regex has
 * no `u` flag, so `\s` is ASCII only and the length counts bytes).
 */
function isRefPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[ \t\n\v\f\r]/.test(value) &&
    new TextEncoder().encode(value).length <= 255
  );
}

/**
 * A ref part that reaches the Gateway unchanged. The sync sends values in Gateway form, which
 * trims strings with JavaScript's `trim()`; that also strips non-ASCII whitespace such as a
 * no-break space, so a part with it at either end would be sent as another thread's ref. The
 * Gateway trims the same way, so it never stores such a part.
 */
function isSendableRefPart(value: unknown): value is string {
  return isRefPart(value) && value.trim() === value;
}

/**
 * The section's thread keys in order, without duplicates; null when the value is not one. A part
 * the write would trim makes the value malformed: the Gateway never stores one, and adopting it
 * would send another thread's ref (or drop the mark) on the next write.
 */
export function parseSidebarHiddenThreads(value: unknown): string[] | null {
  if (
    !isJsonObject(value) ||
    typeof value.schema !== "number" ||
    !Number.isInteger(value.schema) ||
    value.schema < 1 ||
    value.schema > 1000
  )
    return null;
  if (!Array.isArray(value.threads)) return null;
  const keys = new Set<string>();
  for (const entry of value.threads) {
    if (!isJsonObject(entry)) return null;
    const { environmentId, threadId } = entry;
    // The key's first ":" separates the parts, so an environment id never holds one.
    if (
      !isSendableRefPart(environmentId) ||
      !isSendableRefPart(threadId) ||
      environmentId.includes(":")
    ) {
      return null;
    }
    const key = sidebarHiddenThreadKey(environmentId, threadId);
    if (keys.has(key)) return null;
    keys.add(key);
  }
  return [...keys];
}

/** The set is larger than the profile section holds. Nothing is trimmed: the marks stay local. */
export class SidebarHiddenThreadsCapacityError extends Schema.TaggedError<SidebarHiddenThreadsCapacityError>()(
  "SidebarHiddenThreadsCapacityError",
  { message: Schema.String, rows: Schema.Number, bytes: Schema.Number },
) {}

function capacityError(rows: number, bytes: number): SidebarHiddenThreadsCapacityError {
  return new SidebarHiddenThreadsCapacityError({
    rows,
    bytes,
    message:
      `Too many hidden sidebar threads to sync (${rows} of ${SIDEBAR_HIDDEN_THREADS_LIMITS.rows}, ` +
      `${bytes} of ${SIDEBAR_HIDDEN_THREADS_LIMITS.bytes} bytes). They stay hidden on this ` +
      "device. Show some of them again from the Orbit panel to sync the rest.",
  });
}

/**
 * The section for a set of keys, oldest first. A key the Gateway would refuse, or one the write
 * would change, is left out, so one bad local mark cannot fail the whole write or hide another
 * thread; it stays hidden on this device only.
 */
function sidebarHiddenThreadsSection(keys: readonly string[]): JsonObject {
  const threads = keys.flatMap((key) => {
    const separator = key.indexOf(":");
    const environmentId = key.slice(0, separator);
    const threadId = key.slice(separator + 1);
    if (separator <= 0 || !isSendableRefPart(environmentId) || !isSendableRefPart(threadId))
      return [];
    return [{ environmentId, threadId }];
  });
  return { schema: PROFILE_SCHEMA_VERSION, threads };
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The set after this device's intents, cut to the Gateway's limits: shows always leave it, and
 * new hides join at the end only while they fit. A hide that does not fit stays a local intent.
 */
function fitSidebarHiddenIntents(
  agreed: readonly string[],
  ops: ReadonlyMap<string, { readonly intent: SidebarHiddenIntent }>,
): { readonly keys: string[]; readonly overflow: SidebarHiddenThreadsCapacityError | null } {
  const keys = agreed.filter((key) => ops.get(key)?.intent !== "show");
  const present = new Set(keys);
  let rows = keys.length;
  let bytes = byteLength(sidebarHiddenThreadsSection(keys));
  let wantedRows = rows;
  let wantedBytes = bytes;
  for (const [key, op] of ops) {
    if (op.intent !== "hide" || present.has(key)) continue;
    const entry = sidebarHiddenThreadsSection([key]).threads as unknown[];
    if (entry.length === 0) continue;
    const size = byteLength(entry[0]) + (rows > 0 ? 1 : 0);
    wantedRows += 1;
    wantedBytes += byteLength(entry[0]) + (wantedRows > 1 ? 1 : 0);
    if (rows + 1 > SIDEBAR_HIDDEN_THREADS_LIMITS.rows) continue;
    if (bytes + size > SIDEBAR_HIDDEN_THREADS_LIMITS.bytes) continue;
    keys.push(key);
    present.add(key);
    rows += 1;
    bytes += size;
  }
  const overflow =
    wantedRows > rows || wantedBytes > bytes ? capacityError(wantedRows, wantedBytes) : null;
  return { keys, overflow };
}

/** The set after this device's intents: shows leave it, new hides join at the end. */
export function applySidebarHiddenIntents(
  agreed: readonly string[],
  ops: ReadonlyMap<string, { readonly intent: SidebarHiddenIntent }>,
): string[] {
  const result = agreed.filter((key) => ops.get(key)?.intent !== "show");
  const present = new Set(result);
  for (const [key, op] of ops) {
    if (op.intent === "hide" && !present.has(key)) result.push(key);
  }
  return result;
}

export interface SidebarHiddenThreadsHost {
  readonly read: () => {
    readonly agreed: readonly string[];
    readonly ops: ReadonlyMap<string, SidebarHiddenOp>;
  };
  /**
   * The set the profile holds now, and the intents it satisfies: `done` maps each key to the op id
   * that was planned. The host retires an op only while it still holds that id.
   */
  readonly adopt: (agreed: readonly string[], done: ReadonlyMap<string, string>) => void;
}

/**
 * The profile sync channel. A write rebases the device's unsent ops onto the profile's latest set
 * instead of sending a snapshot, so another device's change is never undone and a first sync never
 * reads as deleting the profile's marks. Ops retire only against a value the Gateway returned.
 */
export function createSidebarHiddenThreadsChannel(
  host: SidebarHiddenThreadsHost,
): ProfileSyncChannel & {
  /** Hides the last rebase could not fit; they stay hidden on this device only. */
  readonly overflow: () => SidebarHiddenThreadsCapacityError | null;
} {
  // The ops the last rebase planned from; `applyRemote` follows `merge` within one run.
  let planned: ReadonlyMap<string, SidebarHiddenOp> = new Map();
  let overflow: SidebarHiddenThreadsCapacityError | null = null;
  return {
    overflow: () => overflow,
    name: SIDEBAR_HIDDEN_THREADS_SECTION,
    rebases: true,
    empty: sidebarHiddenThreadsSection([]),
    hasPending: () => host.read().ops.size > 0,
    accepts: (value) => parseSidebarHiddenThreads(value) !== null,
    readLocal: () => {
      const { agreed, ops } = host.read();
      return sidebarHiddenThreadsSection(applySidebarHiddenIntents(agreed, ops));
    },
    applyRemote: (value) => {
      const agreed = parseSidebarHiddenThreads(value) ?? [];
      const present = new Set(agreed);
      const done = new Map<string, string>();
      for (const [key, op] of planned) {
        if ((op.intent === "hide") === present.has(key)) done.set(key, op.id);
      }
      planned = new Map();
      host.adopt(agreed, done);
    },
    merge: (_base, _local, remote) => {
      planned = host.read().ops;
      const agreed = parseSidebarHiddenThreads(remote) ?? [];
      // The latest read is what the device agrees on, also when the write below fails.
      host.adopt(agreed, new Map());
      // A section written by a newer schema is left as it is.
      if (typeof remote.schema === "number" && remote.schema > PROFILE_SCHEMA_VERSION) {
        overflow = null;
        return remote;
      }
      // Shows and the hides that fit go out; the rest wait locally and do not hold them back.
      const fitted = fitSidebarHiddenIntents(agreed, planned);
      overflow = fitted.overflow;
      return sidebarHiddenThreadsSection(fitted.keys);
    },
  };
}
