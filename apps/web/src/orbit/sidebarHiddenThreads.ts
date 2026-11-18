import {
  createSidebarHiddenThreadsChannel,
  sidebarHiddenThreadKey,
  type SidebarHiddenIntent,
  type SidebarHiddenOp,
} from "@t3tools/client-runtime/orbit-gateway";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { useEnvironmentProvider } from "./environmentProvider";
import { notifyLocalProfileChange } from "./profileSyncRegistry";
import {
  NO_SIDEBAR_HIDDEN_MARKS,
  planSidebarPeek,
  sidebarHiddenMarks,
  type SidebarHiddenMarks,
  type SidebarPeekAttempt,
} from "./sidebarHiddenThreads.logic";
import { readSidebarThreadInventory } from "./sidebarInventory";

/**
 * Conn: this device's sidebar marks, one localStorage entry per thread intent and peek attempt,
 * so two windows that edit different threads never overwrite each other. The main window's
 * profile sync alone writes `active`, `last` and each profile's `agreed` set; every window
 * follows them through the storage event.
 */
const PREFIX = "t3code:sidebar-hidden-threads:v2:";
const ACTIVE_KEY = `${PREFIX}active`;
const LAST_KEY = `${PREFIX}last`;
/** Saved pairings the Gateway's last listing did not claim: proven not Orbit's. */
const NOT_ORBIT_KEY = `${PREFIX}not-orbit`;
/** Confirmed unbound: Orbit on and the Gateway names no profile. Its marks are this bucket's. */
const NO_PROFILE = "none";
/** Orbit mode off. Turning it on again waits for a fresh bind, unless `last` is cached. */
const OFF = "off";

const agreedKey = (profile: string) => `${PREFIX}agreed:${profile}`;
const opKey = (profile: string, key: string) => `${PREFIX}op:${profile}:${key}`;
const attemptKey = (id: string) => `${PREFIX}attempt:${id}`;

/** This window, as the owner of the peeks it prepares. */
const WINDOW_ID = randomUUID();
/** An unresolved peek's owner says it is alive this often; one silent this long is an orphan. */
const ATTEMPT_BEAT_MS = 10_000;
const ATTEMPT_ORPHAN_MS = 60_000;
/** Pauses between failed inventory reads; the hold stays meanwhile. */
const INVENTORY_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

interface Stored {
  /** A profile id, `none`, `off`, or null before the main window's first bind. */
  readonly active: string | null;
  /** The profile bound last, so turning Orbit on again offline keeps its cached marks. */
  readonly last: string | null;
  readonly agreed: Map<string, string[]>;
  readonly ops: Map<string, Map<string, SidebarHiddenOp>>;
  readonly attempts: Map<string, SidebarPeekAttempt>;
  readonly notOrbit: ReadonlySet<string>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function parse(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** `<profile>:<rest>`; profiles never hold a ":". */
function split(rest: string): [string, string] | null {
  const separator = rest.indexOf(":");
  return separator <= 0 ? null : [rest.slice(0, separator), rest.slice(separator + 1)];
}

function inner<V>(map: Map<string, Map<string, V>>, profile: string): Map<string, V> {
  let entry = map.get(profile);
  if (!entry) map.set(profile, (entry = new Map()));
  return entry;
}

function readStored(): Stored {
  const stored: Stored = {
    active: null,
    last: null,
    agreed: new Map(),
    ops: new Map(),
    attempts: new Map(),
    notOrbit: new Set(),
  };
  if (typeof window === "undefined") return stored;
  const storage = window.localStorage;
  let active: string | null = null;
  let last: string | null = null;
  let notOrbit: ReadonlySet<string> = stored.notOrbit;
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (name === null || !name.startsWith(PREFIX)) continue;
    const value = parse(storage.getItem(name));
    const rest = name.slice(PREFIX.length);
    if (name === ACTIVE_KEY) {
      if (typeof value === "string") active = value;
    } else if (name === LAST_KEY) {
      if (typeof value === "string") last = value;
    } else if (name === NOT_ORBIT_KEY) {
      notOrbit = new Set(strings(value));
    } else if (rest.startsWith("agreed:")) {
      stored.agreed.set(rest.slice("agreed:".length), strings(value));
    } else if (rest.startsWith("op:")) {
      const parts = split(rest.slice("op:".length));
      const op = value as Partial<SidebarHiddenOp> | null;
      if (!parts || typeof op !== "object" || op === null || typeof op.id !== "string") continue;
      if (op.intent !== "hide" && op.intent !== "show") continue;
      inner(stored.ops, parts[0]).set(parts[1], { intent: op.intent, id: op.id });
    } else if (rest.startsWith("attempt:")) {
      const attempt = value as Partial<SidebarPeekAttempt> | null;
      if (typeof attempt !== "object" || attempt === null) continue;
      if (typeof attempt.profile !== "string" || typeof attempt.environmentId !== "string")
        continue;
      stored.attempts.set(rest.slice("attempt:".length), {
        profile: attempt.profile,
        environmentId: attempt.environmentId,
        target: typeof attempt.target === "string" ? attempt.target : null,
        hold: attempt.hold === true,
        committed: attempt.committed === true,
        shown: strings(attempt.shown),
        ...(typeof attempt.owner === "string" ? { owner: attempt.owner } : {}),
        ...(typeof attempt.beat === "number" ? { beat: attempt.beat } : {}),
      });
    }
  }
  return { ...stored, active, last, notOrbit };
}

function write(name: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the marks hold until the next read.
  }
}

const isProfile = (active: string | null): active is string =>
  active !== null && active !== NO_PROFILE && active !== OFF;

/**
 * The bucket whose marks apply, and whether they are known. Orbit on with no bind for this spell
 * yet is pending: the last profile's cached marks apply, or Orbit rows wait.
 */
function binding(stored: Stored): { readonly profile: string; readonly hydrated: boolean } {
  if (isProfile(stored.active)) {
    return { profile: stored.active, hydrated: stored.agreed.has(stored.active) };
  }
  if (stored.active === NO_PROFILE) return { profile: NO_PROFILE, hydrated: true };
  if (useEnvironmentProvider.getState().provider !== "orbit") {
    return { profile: NO_PROFILE, hydrated: true };
  }
  if (stored.last !== null && stored.agreed.has(stored.last)) {
    return { profile: stored.last, hydrated: true };
  }
  return { profile: NO_PROFILE, hydrated: false };
}

/** Enabled pairings (the kind Orbit makes); a fresh client may not know yet which are Orbit's. */
function pairedEnvironmentIds(): string[] {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return [...catalog.entries].flatMap(([environmentId, entry]) =>
    entry.enabled && entry.target._tag === "BearerConnectionTarget" ? [String(environmentId)] : [],
  );
}

/**
 * Environments whose rows wait for the profile's marks: the ones Orbit provides on this device,
 * and every pairing the Gateway's listing has not proven to be another server's.
 */
function orbitEnvironmentIds(notOrbit: ReadonlySet<string>): string[] {
  const { provider, state, orbitInstances } = useEnvironmentProvider.getState();
  if (provider !== "orbit") return [];
  const known = [
    ...state.pairedByOrbit,
    ...Object.keys(state.pairAttemptedAt ?? {}),
    ...Object.keys(orbitInstances),
  ];
  const unproven = pairedEnvironmentIds().filter((environmentId) => !notOrbit.has(environmentId));
  return [...new Set([...known, ...unproven])];
}

/** The main window's sync, after each Gateway listing: pairings it did not claim are not Orbit's. */
export function classifySidebarEnvironments(orbitEnvironmentIds: readonly string[]): void {
  const orbit = new Set(orbitEnvironmentIds);
  const notOrbit = pairedEnvironmentIds()
    .filter((environmentId) => !orbit.has(environmentId))
    .sort();
  if (JSON.stringify(notOrbit) === window.localStorage.getItem(NOT_ORBIT_KEY)) return;
  write(NOT_ORBIT_KEY, notOrbit);
  refresh();
}

interface SidebarHiddenState {
  /** A profile id, `none`, `off`, or null before the main window's first bind. */
  readonly active: string | null;
  readonly marks: SidebarHiddenMarks;
}

let lastSignature = "";

function compute(): SidebarHiddenState {
  const stored = readStored();
  const { profile, hydrated } = binding(stored);
  const input = {
    agreed: stored.agreed.get(profile) ?? [],
    ops: stored.ops.get(profile) ?? new Map<string, SidebarHiddenOp>(),
    attempts: [...stored.attempts.values()].filter((attempt) => attempt.profile === profile),
    unhydrated: hydrated ? [] : orbitEnvironmentIds(stored.notOrbit),
  };
  lastSignature = JSON.stringify([
    stored.active,
    profile,
    input.agreed,
    [...input.ops].map(([key, op]) => [key, op.intent]),
    input.attempts.map(({ beat: _beat, ...attempt }) => attempt),
    input.unhydrated,
  ]);
  return { active: stored.active, marks: sidebarHiddenMarks(input) };
}

export const useSidebarHiddenThreads = create<SidebarHiddenState>(() =>
  typeof window === "undefined" ? { active: null, marks: NO_SIDEBAR_HIDDEN_MARKS } : compute(),
);

function refresh(): void {
  const previous = lastSignature;
  const next = compute();
  if (lastSignature !== previous) useSidebarHiddenThreads.setState(next);
}

function setOp(profile: string, key: string, intent: SidebarHiddenIntent): void {
  write(opKey(profile, key), { intent, id: randomUUID() });
}

/**
 * The main window's profile sync names the binding before each run: a profile id, `null` when the
 * Gateway names no profile (confirmed unbound), or `off` when Orbit mode is off. Marks made while
 * no profile was bound move to the first profile bound after.
 */
export function bindSidebarHiddenProfile(profileId: number | null | typeof OFF): void {
  const stored = readStored();
  const next = profileId === OFF ? OFF : profileId === null ? NO_PROFILE : String(profileId);
  if (stored.active === next) return;
  if (isProfile(next) && !isProfile(stored.active)) {
    for (const [key, op] of stored.ops.get(NO_PROFILE) ?? []) {
      write(opKey(next, key), op);
      write(opKey(NO_PROFILE, key), undefined);
    }
    for (const [id, attempt] of stored.attempts) {
      if (attempt.profile === NO_PROFILE) write(attemptKey(id), { ...attempt, profile: next });
    }
  } else if (!isProfile(next) && isProfile(stored.active)) {
    // Leaving a profile: what an earlier unbound spell left is not this one's to carry over.
    for (const key of stored.ops.get(NO_PROFILE)?.keys() ?? []) {
      write(opKey(NO_PROFILE, key), undefined);
    }
  }
  // A confirmed unbound device has no cached profile: after Orbit off and on, rows wait.
  if (isProfile(next)) write(LAST_KEY, next);
  else if (next === NO_PROFILE) write(LAST_KEY, undefined);
  write(ACTIVE_KEY, next);
  refresh();
  resumeSweeps();
}

export function hideSidebarThread(ref: { environmentId: string; threadId: string }): void {
  setOp(
    binding(readStored()).profile,
    sidebarHiddenThreadKey(ref.environmentId, ref.threadId),
    "hide",
  );
  refresh();
  notifyLocalProfileChange();
}

/**
 * An explicit open: this thread shows at once, wins over any hide still queued for it and over a
 * peek's provisional hide, and stays out of the sweep of its environment's threads.
 */
export function showSidebarThread(ref: { environmentId: string; threadId: string }): void {
  const stored = readStored();
  const profile = binding(stored).profile;
  const key = sidebarHiddenThreadKey(ref.environmentId, ref.threadId);
  setOp(profile, key, "show");
  for (const [id, attempt] of stored.attempts) {
    if (attempt.profile !== profile || attempt.environmentId !== ref.environmentId) continue;
    if (!attempt.shown.includes(key)) {
      write(attemptKey(id), { ...attempt, shown: [...attempt.shown, key] });
    }
  }
  refresh();
  notifyLocalProfileChange();
}

const sweeping = new Map<string, () => void>();

const holdsOf = (stored: Stored, profile: string, environmentId: string) =>
  [...stored.attempts].filter(
    ([, attempt]) =>
      attempt.profile === profile &&
      attempt.environmentId === environmentId &&
      attempt.hold &&
      attempt.committed,
  );

/**
 * Once a held environment connects, one untrimmed read lists all its threads, older settled ones
 * and idle subagents included; each one nobody showed is marked, then the hold goes. A failed
 * read keeps the hold and tries again after a pause, without subscribing again.
 */
function sweepWhenLive(profile: string, environmentId: string): void {
  const id = `${profile}|${environmentId}`;
  if (sweeping.has(id)) return;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let done = false;
  let failures = 0;
  const finish = () => {
    done = true;
    sweeping.delete(id);
    unsubscribe?.();
    if (timer !== null) clearTimeout(timer);
  };
  sweeping.set(id, finish);
  const read = async (): Promise<void> => {
    timer = null;
    if (done) return;
    if (holdsOf(readStored(), profile, environmentId).length === 0) return finish();
    const inventory = await readSidebarThreadInventory(environmentId).catch(() => null);
    if (done) return;
    if (inventory === null) {
      const pause = INVENTORY_RETRY_MS[Math.min(failures, INVENTORY_RETRY_MS.length - 1)];
      failures += 1;
      timer = setTimeout(() => void read(), pause);
      return;
    }
    finish();
    sweep(
      profile,
      environmentId,
      inventory.map((thread) => String(thread.id)),
    );
  };
  unsubscribe = appAtomRegistry.subscribe(
    environmentShell.stateValueAtom(environmentId as EnvironmentId),
    (shell) => {
      if (done || started || shell.status !== "live") return;
      started = true;
      queueMicrotask(() => {
        unsubscribe?.();
        unsubscribe = null;
        void read();
      });
    },
    { immediate: true },
  );
}

function sweep(profile: string, environmentId: string, threadIds: readonly string[]): void {
  const stored = readStored();
  const holds = holdsOf(stored, profile, environmentId);
  if (holds.length === 0) return;
  const shown = new Set<string>();
  for (const [, attempt] of holds) for (const key of attempt.shown) shown.add(key);
  const ops = stored.ops.get(profile);
  const agreed = new Set(stored.agreed.get(profile) ?? []);
  for (const threadId of threadIds) {
    const key = sidebarHiddenThreadKey(environmentId, threadId);
    if (shown.has(key) || ops?.has(key) || agreed.has(key)) continue;
    setOp(profile, key, "hide");
  }
  // The whole set is in the intent store now; the hold goes and only per-thread marks remain.
  for (const [attemptId] of holds) write(attemptKey(attemptId), undefined);
  refresh();
  notifyLocalProfileChange();
}

function resumeSweeps(): void {
  const stored = readStored();
  const profile = binding(stored).profile;
  for (const attempt of stored.attempts.values()) {
    if (attempt.profile === profile && attempt.hold && attempt.committed) {
      sweepWhenLive(profile, attempt.environmentId);
    }
  }
}

/** Unresolved peeks this window prepares; their beat keeps other windows from recovering them. */
const ownPending = new Set<string>();
let beatTimer: ReturnType<typeof setInterval> | null = null;

function beat(): void {
  const stored = readStored();
  for (const id of ownPending) {
    const attempt = stored.attempts.get(id);
    if (attempt && !attempt.committed) write(attemptKey(id), { ...attempt, beat: Date.now() });
    else ownPending.delete(id);
  }
  if (ownPending.size === 0 && beatTimer !== null) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

function trackOwnAttempt(id: string): void {
  ownPending.add(id);
  beatTimer ??= setInterval(beat, ATTEMPT_BEAT_MS);
}

function releaseOwnAttempt(id: string): void {
  ownPending.delete(id);
  if (ownPending.size === 0 && beatTimer !== null) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

/**
 * Drops unresolved peeks whose window closed or crashed: no beat for `ATTEMPT_ORPHAN_MS`. A live
 * window's peek beats, and committed holds belong to every window, so neither is touched.
 */
function recoverOrphanAttempts(): void {
  const stored = readStored();
  const stale = Date.now() - ATTEMPT_ORPHAN_MS;
  let changed = false;
  for (const [id, attempt] of stored.attempts) {
    if (attempt.committed || ownPending.has(id)) continue;
    if ((attempt.beat ?? 0) >= stale) continue;
    write(attemptKey(id), undefined);
    changed = true;
  }
  if (changed) refresh();
}

/** The thread keys the sidebar of this window lists now, under its scope. */
let listedThreadKeys: ReadonlySet<string> = new Set();

export function publishSidebarListedThreads(keys: ReadonlySet<string>): void {
  listedThreadKeys = keys;
}

/** Whether this window's sidebar lists the thread now: a row under the current scope. */
export function isSidebarListedNow(environmentId: string, threadId: string): boolean {
  return listedThreadKeys.has(sidebarHiddenThreadKey(environmentId, threadId));
}

/** The sync channel for one profile; its reads and acknowledgements never touch another one. */
export function sidebarHiddenThreadsChannel(
  profileId: number,
): ReturnType<typeof createSidebarHiddenThreadsChannel> {
  const profile = String(profileId);
  return createSidebarHiddenThreadsChannel({
    read: () => {
      const stored = readStored();
      return {
        agreed: stored.agreed.get(profile) ?? [],
        ops: stored.ops.get(profile) ?? new Map(),
      };
    },
    adopt: (agreed, done) => {
      write(agreedKey(profile), agreed);
      for (const [key, id] of done) {
        // Retired only while the op is the one the write carried; a newer edit stays.
        const current = parse(window.localStorage.getItem(opKey(profile, key))) as {
          id?: unknown;
        } | null;
        if (current?.id === id) write(opKey(profile, key), undefined);
      }
      refresh();
    },
  });
}

let watched = false;
/** Follows the marks other windows and the main window's sync write. */
export function watchSidebarHiddenThreads(): void {
  if (watched || typeof window === "undefined") return;
  watched = true;
  // A closing window gives up the peeks it was still preparing; a crash waits for recovery.
  window.addEventListener("pagehide", () => {
    for (const id of ownPending) {
      const attempt = readStored().attempts.get(id);
      if (attempt && !attempt.committed) write(attemptKey(id), undefined);
      releaseOwnAttempt(id);
    }
  });
  recoverOrphanAttempts();
  setInterval(recoverOrphanAttempts, ATTEMPT_ORPHAN_MS / 2);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && !event.key.startsWith(PREFIX)) return;
    const before = useSidebarHiddenThreads.getState().active;
    refresh();
    // Every window sweeps a committed hold, so one closed mid-read leaves no orphan. A sweep marks
    // only unmarked threads and drops the holds, so the window that reads second finds no work.
    if (
      useSidebarHiddenThreads.getState().active !== before ||
      event.key === null ||
      event.key.startsWith(`${PREFIX}attempt:`)
    ) {
      resumeSweeps();
    }
    // Another window's edit: the main window's sync sends it.
    if (event.key?.startsWith(`${PREFIX}op:`)) notifyLocalProfileChange();
  });
  useEnvironmentProvider.subscribe(refresh);
  appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, refresh);
  resumeSweeps();
}

export interface SidebarPeek {
  /** Preparation succeeded: the target's hide becomes a mark and a hold waits for the threads. */
  readonly commit: () => void;
  /** Preparation failed: only this attempt's effects go. */
  readonly cancel: () => void;
}

const NO_PEEK: SidebarPeek = { commit: () => {}, cancel: () => {} };

/**
 * A Tasks agent click: opens the conversation without adding it to the sidebar. A thread the
 * sidebar lists stays listed; any other is hidden, and an environment the click surfaces (unpaired
 * or switched off here) is held so its other threads do not flash in. Until `commit`, both are
 * this attempt's own, so an overlapping peek or a profile switch never takes them over.
 */
export function beginSidebarPeek(
  target: { environmentId: string; threadId: string },
  facts: { readonly targetListed: boolean; readonly environmentSurfaced: boolean },
): SidebarPeek {
  const plan = planSidebarPeek(facts);
  if (!plan.hideTarget && !plan.holdEnvironment) return NO_PEEK;
  const id = randomUUID();
  const key = sidebarHiddenThreadKey(target.environmentId, target.threadId);
  const attempt: SidebarPeekAttempt = {
    profile: binding(readStored()).profile,
    environmentId: target.environmentId,
    target: plan.hideTarget ? key : null,
    hold: plan.holdEnvironment,
    committed: false,
    shown: [],
    owner: WINDOW_ID,
    beat: Date.now(),
  };
  write(attemptKey(id), attempt);
  trackOwnAttempt(id);
  refresh();
  return {
    commit: () => {
      releaseOwnAttempt(id);
      const stored = readStored();
      const current = stored.attempts.get(id);
      if (!current) return;
      if (current.profile !== binding(stored).profile) {
        write(attemptKey(id), undefined);
      } else {
        if (current.target !== null && !current.shown.includes(current.target)) {
          setOp(current.profile, current.target, "hide");
        }
        if (current.hold) {
          const { owner: _owner, beat: _beat, ...held } = current;
          write(attemptKey(id), { ...held, target: null, committed: true });
          sweepWhenLive(current.profile, current.environmentId);
        } else {
          write(attemptKey(id), undefined);
        }
        notifyLocalProfileChange();
      }
      refresh();
    },
    cancel: () => {
      releaseOwnAttempt(id);
      write(attemptKey(id), undefined);
      refresh();
    },
  };
}
