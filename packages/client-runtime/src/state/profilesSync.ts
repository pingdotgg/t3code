import {
  type EnvironmentId,
  ProfilesError,
  type ProfilesSyncReadResult,
  type ProfilesSyncState,
  type ProfilesSyncWriteResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { ProfilesEnvironmentAtoms } from "./profiles.ts";
import { type AtomCommandResult, runAtomCommand } from "./runtime.ts";

export interface ProfilesSyncParticipant {
  readonly environmentId: EnvironmentId;
  readonly state: ProfilesSyncState;
}

export type ProfilesSyncPlan =
  | { readonly kind: "inSync" }
  | {
      readonly kind: "copy";
      readonly winner: ProfilesSyncParticipant;
      readonly targets: ReadonlyArray<ProfilesSyncParticipant>;
    };

export type ProfilesSyncStatus =
  | { readonly kind: "inSync"; readonly revision: number }
  | { readonly kind: "updated"; readonly revision: number; readonly at: string }
  | {
      readonly kind: "backup";
      readonly revision: number;
      readonly at: string;
      readonly path: string;
    }
  | { readonly kind: "failed"; readonly message: string }
  /** Sync is switched off on that environment; it is left alone. */
  | { readonly kind: "off"; readonly revision: number }
  /** The server predates profile sync; it is left alone. */
  | { readonly kind: "unsupported" };

export type ProfilesSyncFailure =
  | { readonly kind: "unsupported" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export type ProfilesSyncAnswer<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ProfilesSyncFailure };

export interface ProfilesSyncIo {
  readonly read: (
    environmentId: EnvironmentId,
    includeFiles: boolean,
  ) => Promise<ProfilesSyncAnswer<ProfilesSyncReadResult>>;
  readonly write: (
    environmentId: EnvironmentId,
    input: {
      readonly expectedRevision: number;
      readonly expectedHash: string;
      readonly source: { readonly hash: string; readonly updatedAt: string | null };
      readonly files: NonNullable<ProfilesSyncReadResult["files"]>;
    },
  ) => Promise<ProfilesSyncAnswer<ProfilesSyncWriteResult>>;
  readonly mark: (
    environmentId: EnvironmentId,
    hash: string,
  ) => Promise<ProfilesSyncAnswer<ProfilesSyncState>>;
  readonly now: () => string;
}

/** The latest change wins; ties go to the higher revision, then to a stable environment order. */
export function pickProfilesSyncWinner(
  participants: ReadonlyArray<ProfilesSyncParticipant>,
): ProfilesSyncParticipant | undefined {
  let winner: ProfilesSyncParticipant | undefined;
  for (const candidate of participants) {
    if (winner === undefined || compareParticipants(candidate, winner) > 0) winner = candidate;
  }
  return winner;
}

const changedAt = (state: ProfilesSyncState) => {
  const at = state.updatedAt === null ? Number.NaN : Date.parse(state.updatedAt);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
};

function compareParticipants(left: ProfilesSyncParticipant, right: ProfilesSyncParticipant) {
  const leftAt = changedAt(left.state);
  const rightAt = changedAt(right.state);
  if (leftAt !== rightAt) return leftAt > rightAt ? 1 : -1;
  if (left.state.revision !== right.state.revision) {
    return left.state.revision - right.state.revision;
  }
  return left.environmentId < right.environmentId
    ? 1
    : left.environmentId > right.environmentId
      ? -1
      : 0;
}

export function planProfilesSync(
  participants: ReadonlyArray<ProfilesSyncParticipant>,
): ProfilesSyncPlan {
  const winner = pickProfilesSyncWinner(participants);
  const targets =
    winner === undefined
      ? []
      : participants.filter((participant) => participant.state.hash !== winner.state.hash);
  if (winner === undefined || targets.length === 0) {
    return { kind: "inSync" };
  }
  return { kind: "copy", winner, targets };
}

export interface ProfilesSyncRunResult {
  readonly statuses: ReadonlyMap<EnvironmentId, ProfilesSyncStatus>;
  /** A target changed while it was being copied to; the caller runs once more. */
  readonly conflicted: boolean;
}

const failedStatus = (failure: ProfilesSyncFailure): ProfilesSyncStatus =>
  failure.kind === "unsupported" ? failure : { kind: "failed", message: failure.message };

async function runProfilesSyncOnce(
  io: ProfilesSyncIo,
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<ProfilesSyncRunResult> {
  const statuses = new Map<EnvironmentId, ProfilesSyncStatus>();
  const reads = await Promise.all(
    environmentIds.map(async (environmentId) => ({
      environmentId,
      answer: await io.read(environmentId, false),
    })),
  );
  const participants: ProfilesSyncParticipant[] = [];
  for (const { environmentId, answer } of reads) {
    if (!answer.ok) statuses.set(environmentId, failedStatus(answer.failure));
    else if (answer.value.enabled === false)
      statuses.set(environmentId, { kind: "off", revision: answer.value.state.revision });
    else participants.push({ environmentId, state: answer.value.state });
  }
  const plan = planProfilesSync(participants);
  if (plan.kind === "inSync") {
    for (const participant of participants) {
      statuses.set(participant.environmentId, {
        kind: "inSync",
        revision: participant.state.revision,
      });
    }
    return { statuses, conflicted: false };
  }

  const source = await io.read(plan.winner.environmentId, true);
  if (!source.ok || source.value.files === undefined) {
    const message = source.ok
      ? "The source copy sent no files."
      : source.failure.kind === "unsupported"
        ? "The source copy stopped answering."
        : source.failure.message;
    for (const participant of participants) {
      statuses.set(participant.environmentId, { kind: "failed", message });
    }
    return { statuses, conflicted: false };
  }
  const winnerState = source.value.state;
  const files = source.value.files;
  statuses.set(plan.winner.environmentId, { kind: "inSync", revision: winnerState.revision });
  for (const participant of participants) {
    if (
      participant.environmentId !== plan.winner.environmentId &&
      participant.state.hash === winnerState.hash
    ) {
      statuses.set(participant.environmentId, {
        kind: "inSync",
        revision: participant.state.revision,
      });
    }
  }

  let conflicted = false;
  let allCopied = true;
  const targets = participants.filter(
    (participant) =>
      participant.environmentId !== plan.winner.environmentId &&
      participant.state.hash !== winnerState.hash,
  );
  await Promise.all(
    targets.map(async (target) => {
      const answer = await io.write(target.environmentId, {
        expectedRevision: target.state.revision,
        expectedHash: target.state.hash,
        source: { hash: winnerState.hash, updatedAt: winnerState.updatedAt },
        files,
      });
      if (answer.ok) {
        const at = io.now();
        statuses.set(
          target.environmentId,
          answer.value.backupPath === undefined
            ? { kind: "updated", revision: answer.value.state.revision, at }
            : {
                kind: "backup",
                revision: answer.value.state.revision,
                at,
                path: answer.value.backupPath,
              },
        );
        return;
      }
      allCopied = false;
      if (answer.failure.kind === "conflict") conflicted = true;
      statuses.set(target.environmentId, failedStatus(answer.failure));
    }),
  );
  if (allCopied) await io.mark(plan.winner.environmentId, winnerState.hash);
  return { statuses, conflicted };
}

/** Runs a sync, and once more when a target changed while it was being copied to. */
export async function runProfilesSync(
  io: ProfilesSyncIo,
  environmentIds: () => ReadonlyArray<EnvironmentId>,
): Promise<ReadonlyMap<EnvironmentId, ProfilesSyncStatus>> {
  const first = await runProfilesSyncOnce(io, environmentIds());
  if (!first.conflicted) return first.statuses;
  return (await runProfilesSyncOnce(io, environmentIds())).statuses;
}

const isProfilesError = Schema.is(ProfilesError);

const UNKNOWN_METHOD = /Unknown request tag/;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  // Empty: syncStatusText says the sync failed in the UI language.
  return "";
}

/** Older servers answer an unknown RPC with a defect naming the request tag. */
export function classifyProfilesSyncFailure(cause: Cause.Cause<unknown>): ProfilesSyncFailure {
  const error = Cause.squash(cause);
  if (isProfilesError(error)) {
    return error.reason === "conflict"
      ? { kind: "conflict", message: error.message }
      : { kind: "failed", message: error.message };
  }
  const message = errorText(error);
  if (UNKNOWN_METHOD.test(message) || UNKNOWN_METHOD.test(Cause.pretty(cause))) {
    return { kind: "unsupported" };
  }
  return { kind: "failed", message };
}

function answer<A, E>(result: AtomCommandResult<A, E>): ProfilesSyncAnswer<A> {
  return result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, failure: classifyProfilesSyncFailure(result.cause) };
}

export interface ProfilesSyncSnapshot {
  readonly running: boolean;
  readonly statuses: ReadonlyMap<EnvironmentId, ProfilesSyncStatus>;
  readonly lastRunAt: string | null;
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const QUIET = { reportFailure: false, reportDefect: false } as const;

/**
 * One sync for the whole client. Runs never overlap: a request during a run
 * queues exactly one more run, which reads the participants afresh.
 */
export function createProfilesSync(atoms: ProfilesEnvironmentAtoms) {
  const snapshotAtom = Atom.make<ProfilesSyncSnapshot>({
    running: false,
    statuses: new Map(),
    lastRunAt: null,
  }).pipe(Atom.keepAlive, Atom.withLabel("profiles:sync"));
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const io = (registry: AtomRegistry.AtomRegistry): ProfilesSyncIo => ({
    read: async (environmentId, includeFiles) =>
      answer(
        await runAtomCommand(
          registry,
          atoms.readSync,
          { environmentId, input: { includeFiles } },
          QUIET,
        ),
      ),
    write: async (environmentId, input) =>
      answer(await runAtomCommand(registry, atoms.writeSync, { environmentId, input }, QUIET)),
    mark: async (environmentId, hash) =>
      answer(
        await runAtomCommand(registry, atoms.markSync, { environmentId, input: { hash } }, QUIET),
      ),
    now: () => nowIso(),
  });

  const runNow = async (
    registry: AtomRegistry.AtomRegistry,
    participants: () => ReadonlyArray<EnvironmentId>,
  ) => {
    registry.update(snapshotAtom, (snapshot) => ({ ...snapshot, running: true }));
    try {
      const statuses = await runProfilesSync(io(registry), participants);
      registry.update(snapshotAtom, (snapshot) => ({
        running: false,
        statuses: new Map([...snapshot.statuses, ...statuses]),
        lastRunAt: nowIso(),
      }));
    } catch (error) {
      registry.update(snapshotAtom, (snapshot) => ({ ...snapshot, running: false }));
      throw error;
    }
  };

  const request = (
    registry: AtomRegistry.AtomRegistry,
    participants: () => ReadonlyArray<EnvironmentId>,
  ): Promise<void> => {
    if (current === null) {
      current = runNow(registry, participants).finally(() => {
        current = null;
      });
      return current;
    }
    if (queued === null) {
      queued = current
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return request(registry, participants);
        });
    }
    return queued;
  };

  return { snapshotAtom, request };
}

export type ProfilesSync = ReturnType<typeof createProfilesSync>;
