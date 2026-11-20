import { useAtomValue } from "@effect/atom-react";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, PullRequestRef, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, useContext, useMemo } from "react";

import { useArtifacts } from "../artifacts/ArtifactsContext";
import { type ConditionState, evaluateReadiness, type PrLive } from "../domain/readiness";
import { connectionAtomRuntime } from "../connection/runtime";
import { ROLES } from "../orchestrator/roles";
import type { FamilyRow, TicketView } from "./boardModel";
import { threadFamilies } from "./family";
import { buildLive, sameRef, ticketPrRef, trackRunning } from "./prLive";

const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
const summaryOf = createLinkedPullRequestSummaryAtomFamily(connectionAtomRuntime);

/** How often a pull request's checks are read again. T3 reads a head with checks still running this often. */
const CHECKS_POLL_MS = 45_000;
const CLOCK_MS = 30_000;

/** Reads of the clock for the stuck rule, which moves with time and not with any data. */
export const clockAtom = Atom.make((get): number => {
  const timer = setInterval(() => get.refreshSelf(), CLOCK_MS);
  get.addFinalizer(() => clearInterval(timer));
  return Date.now();
}).pipe(Atom.withLabel("board-clock"));

const RUNNING_STORE = "board:pr-running";
const RUNNING_KEEP_MS = 24 * 60 * 60_000;
const decodeRunning = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.Number]))),
);

/**
 * When each running check was first seen, across every pull request the board watches. It is
 * kept in local storage, so a reload or a restart does not make a long-running check look new.
 */
const runningSince = new Map<string, number>(
  Option.getOrElse(decodeRunning(localStorage.getItem(RUNNING_STORE) ?? "[]"), () => []).filter(
    ([, since]) => Date.now() - since < RUNNING_KEEP_MS,
  ),
);

const decodeFamilyKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, Schema.String])),
);
const decodePrKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, Schema.String, PullRequestRef])),
);

let savedRunning = localStorage.getItem(RUNNING_STORE);

function saveRunning() {
  const text = JSON.stringify([...runningSince]);
  if (text === savedRunning) return;
  savedRunning = text;
  localStorage.setItem(RUNNING_STORE, text);
}

const NO_LINKS: ReadonlyArray<ThreadPullRequestLink> = [];

/** Every pull request link the thread family carries, from the shell stream and the family read. */
const familyLinksAtom = Atom.family((key: string) => {
  const [environmentId, orchestratorThreadId] = decodeFamilyKey(key);
  return Atom.make((get): ReadonlyArray<ThreadPullRequestLink> => {
    const threads = get(threadFamilies.snapshotAtom(environmentId))?.threads;
    if (threads === undefined) return NO_LINKS;
    return threads
      .filter((thread) => thread.lineage.rootThreadId === orchestratorThreadId)
      .flatMap((thread) => thread.pullRequests ?? []);
  }).pipe(Atom.withLabel(`board-pr-links:${key}`));
});

/** Reads a pull request's checks again on a timer, while the board has it on screen. */
const checksPollAtom = Atom.family((key: string) => {
  const [environmentId, , ref] = decodePrKey(key);
  const checksAtom = pullRequestEnvironment.checks({ environmentId, input: ref });
  return Atom.make((get): null => {
    const timer = setInterval(() => {
      const state = AsyncResult.getOrElse(get.registry.get(checksAtom), () => null)?.state;
      if (state === undefined || state === "open") get.registry.refresh(checksAtom);
    }, CHECKS_POLL_MS);
    get.addFinalizer(() => clearInterval(timer));
    return null;
  });
});

/**
 * One pull request as the board shows it, keyed by `[environmentId, orchestratorThreadId, ref]`
 * as JSON. The value is null until some source answers. It keeps its identity while nothing
 * about the pull request changes, and marks `board:pr-event` when something does.
 */
export const prLiveAtom = Atom.family((key: string) => {
  const [environmentId, orchestratorThreadId, ref] = decodePrKey(key);
  const summaryAtom = summaryOf({ environmentId, input: ref });
  const checksAtom = pullRequestEnvironment.checks({ environmentId, input: ref });
  const linksAtom = familyLinksAtom(JSON.stringify([environmentId, orchestratorThreadId]));
  let last: PrLive | null = null;
  let syncedAt: string | null = null;
  return Atom.make((get): PrLive | null => {
    get(checksPollAtom(key));
    const link = get(linksAtom).find((entry) => sameRef(ref, entry));
    const summary = AsyncResult.getOrElse(get(summaryAtom), () => null);
    const checks = AsyncResult.getOrElse(get(checksAtom), () => null);
    // A new snapshot from the engine says the checks moved, so the list is read again at once.
    const synced = link?.snapshot?.syncedAt ?? null;
    if (synced !== null && synced !== syncedAt) {
      const first = syncedAt === null;
      syncedAt = synced;
      if (!first) queueMicrotask(() => get.registry.refresh(checksAtom));
    }
    // Until the list is read, nothing says which checks stopped, so the clocks stay as they are.
    const runs = checks === null ? [] : trackRunning(runningSince, key, checks.checks, Date.now());
    saveRunning();
    const next = buildLive({ link, summary, checks, runs });
    if (JSON.stringify(next) === JSON.stringify(last)) return last;
    last = next;
    if (next !== null) {
      performance.mark("board:pr-event", {
        detail: { number: ref.number, state: next.checksState },
      });
    }
    return next;
  }).pipe(Atom.withLabel(`board-pr:${key}`));
});

const NO_PR = Atom.make<PrLive | null>(null).pipe(Atom.withLabel("board-pr:none"));

export interface PrContextValue {
  readonly project: EnvironmentProject;
  readonly orchestratorThreadId: string;
  readonly family: ReadonlyArray<FamilyRow>;
  readonly tickets: ReadonlyArray<TicketView>;
  /** The orchestrator's merge-order note for each ticket it asked to merge, by ticket key. */
  readonly mergeOrderNotes: ReadonlyMap<string, string>;
}

const PrContext = createContext<PrContextValue | null>(null);
export const PrProvider = PrContext.Provider;

export function usePrContext(): PrContextValue {
  const value = useContext(PrContext);
  if (value === null) throw new Error("A pull request hook needs a PrProvider");
  return value;
}

export interface TicketPr {
  /** Null when the ticket has no pull request the board can name. */
  readonly ref: PullRequestRef | null;
  /** Null until the host or the engine has answered. */
  readonly live: PrLive | null;
  readonly now: number;
}

/** The ticket's pull request and what the host says about it now. A null view has none. */
export function useTicketPr(view: TicketView | null): TicketPr {
  const { project, orchestratorThreadId, family } = usePrContext();
  const ref = useMemo(() => {
    if (view === null) return null;
    const own = new Set(view.agents.map((agent) => agent.threadId));
    const links = family.filter((row) => own.has(row.id)).flatMap((row) => row.pullRequests ?? []);
    return ticketPrRef(view.ticket, links, project);
  }, [view, family, project]);
  const key =
    ref === null ? null : JSON.stringify([project.environmentId, orchestratorThreadId, ref]);
  const live = useAtomValue(key === null ? NO_PR : prLiveAtom(key));
  return { ref, live, now: useAtomValue(clockAtom) };
}

const REVIEW_ROLES: ReadonlySet<string> = new Set(
  ROLES.filter((role) => role.t3Role === "review").map((role) => role.name),
);

/**
 * The six merge-ready conditions for a ticket, computed from the board's files and the host's
 * checks. A null view has none.
 */
export function useTicketReadiness(view: TicketView | null): ReadonlyArray<ConditionState> | null {
  const { tickets, mergeOrderNotes } = usePrContext();
  const { groups } = useArtifacts();
  const { live, now } = useTicketPr(view);
  return useMemo(
    () =>
      view === null
        ? null
        : evaluateReadiness({
            ticket: view.ticket,
            tickets: tickets.map((entry) => entry.ticket),
            evidence: (groups.byTicket.get(view.ticket.key) ?? []).map((artifact) => artifact.path),
            live,
            mergeOrderNote: mergeOrderNotes.get(view.ticket.key) ?? null,
            reviewRoles: REVIEW_ROLES,
            now,
          }),
    [view, tickets, groups, live, mergeOrderNotes, now],
  );
}
