/**
 * Decisions from every connected environment, merged into one feed
 * (ccez/DECISIONS.md). Each host keeps the decisions its agents asked; the
 * client reads them all and orders them together.
 *
 * @module state/decisions
 */
import { useAtomValue } from "@effect/atom-react";
import {
  buildOneFeed,
  type OneFeedFilter,
  waitingOnOtherDevice,
} from "@cz/client-runtime/decisions/oneFeed";
import { useMemo } from "react";
import type { BriefMachine } from "@cz/client-runtime/decisions/morningBrief";
import { compareFeedItems } from "@cz/client-runtime/decisions/feed";
import {
  createDecisionEnvironmentAtoms,
  threadDigestKey,
} from "@cz/client-runtime/state/decisions";
import type {
  DecisionItemWithAnswer,
  DecisionProjectBlurb,
  EnvironmentId,
  ThreadDigest,
} from "@cz/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveMachineFilter, useFeedFilterStore } from "../feedFilterStore";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePrimaryEnvironmentId } from "./environments";
import { environmentPresentations } from "./presentation";

/** Decisions on each connected environment. */
export const decisionEnvironment = createDecisionEnvironmentAtoms(connectionAtomRuntime);

export interface DecisionEntry extends DecisionItemWithAnswer {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

export interface DecisionFeed {
  readonly entries: readonly DecisionEntry[];
  /** True until every reachable environment has answered once. */
  readonly isPending: boolean;
  /** Environments that couldn't be read (asleep, offline, older server). */
  readonly unreachable: readonly string[];
}

const openFeedAtom = Atom.make((get): DecisionFeed => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const entries: DecisionEntry[] = [];
  const unreachable: string[] = [];
  let isPending = false;
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    const result = get(decisionEnvironment.list({ environmentId, input: { status: "open" } }));
    const items = Option.getOrNull(AsyncResult.value(result));
    if (items === null) {
      if (result._tag === "Failure") unreachable.push(label);
      else isPending = true;
      continue;
    }
    for (const entry of items) entries.push({ ...entry, environmentId, environmentLabel: label });
  }
  entries.sort((a, b) => compareFeedItems(a.item, b.item));
  return { entries, isPending: isPending && entries.length === 0, unreachable };
}).pipe(Atom.withLabel("web-decisions:open-feed"));

export function useOpenDecisions(): DecisionFeed {
  return useAtomValue(openFeedAtom);
}

/** Open decisions asked from one thread (the thread's banner links to them). */
export function useThreadDecisions(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): readonly DecisionEntry[] {
  const feed = useOpenDecisions();
  return threadId === null
    ? []
    : feed.entries.filter(
        (entry) => entry.environmentId === environmentId && entry.item.thread === threadId,
      );
}

// Per thread, so a sidebar row re-renders only when its own count changes.
const threadOpenDecisionCount = Atom.family((key: string) =>
  Atom.make(
    (get) =>
      get(openFeedAtom).entries.filter(
        (entry) => `${entry.environmentId}:${entry.item.thread}` === key,
      ).length,
  ),
);

/** How many open decisions a thread has asked (the sidebar marks those threads). */
export function useThreadOpenDecisionCount(environmentId: EnvironmentId, threadId: string): number {
  return useAtomValue(threadOpenDecisionCount(`${environmentId}:${threadId}`));
}

const answeredFeedAtom = Atom.make((get): DecisionFeed => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const entries: DecisionEntry[] = [];
  const unreachable: string[] = [];
  let isPending = false;
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    const result = get(
      decisionEnvironment.list({ environmentId, input: { status: "answered", limit: 50 } }),
    );
    const items = Option.getOrNull(AsyncResult.value(result));
    if (items === null) {
      if (result._tag === "Failure") unreachable.push(label);
      else isPending = true;
      continue;
    }
    for (const entry of items) entries.push({ ...entry, environmentId, environmentLabel: label });
  }
  entries.sort((a, b) => (b.item.answered_at ?? 0) - (a.item.answered_at ?? 0));
  return { entries, isPending: isPending && entries.length === 0, unreachable };
}).pipe(Atom.withLabel("web-decisions:answered-feed"));

/** Recently answered decisions on every host, newest first (the Answered view). */
export function useAnsweredDecisions(): DecisionFeed {
  return useAtomValue(answeredFeedAtom);
}

const projectBlurbsAtom = Atom.make((get): ReadonlyMap<string, DecisionProjectBlurb> => {
  const blurbs = new Map<string, DecisionProjectBlurb>();
  for (const [environmentId] of get(environmentPresentations.presentationsAtom)) {
    const result = get(decisionEnvironment.projects({ environmentId, input: "all" }));
    for (const blurb of Option.getOrNull(AsyncResult.value(result)) ?? []) {
      const known = blurbs.get(blurb.project);
      // The owner's own line beats a README's, whichever host has it.
      if (blurb.description !== null && (!known?.description || blurb.source === "owner")) {
        blurbs.set(blurb.project, blurb);
      } else if (!known) {
        blurbs.set(blurb.project, blurb);
      }
    }
  }
  return blurbs;
}).pipe(Atom.withLabel("web-decisions:project-blurbs"));

/** One line per decision project to jog the owner's memory. */
export function useProjectBlurbs(): ReadonlyMap<string, DecisionProjectBlurb> {
  return useAtomValue(projectBlurbsAtom);
}

/**
 * The feed filter in effect: machine (this one by default), games or
 * software, picked projects, and this device's kind. Pages and badges read
 * it so their counts agree.
 */
function useFeedFilter(): OneFeedFilter {
  const machine = useFeedFilterStore((state) => state.machine);
  const projects = useFeedFilterStore((state) => state.projects);
  const kinds = useFeedFilterStore((state) => state.kinds);
  const showPhoneItems = useFeedFilterStore((state) => state.showPhoneItems);
  const group = useFeedFilterStore((state) => state.group);
  const blurbs = useProjectBlurbs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const phone = useMediaQuery("(pointer: coarse) and (max-width: 640px)");
  return useMemo(
    () => ({
      machine: resolveMachineFilter(machine, primaryEnvironmentId),
      projects: new Set(projects),
      kinds: new Set(kinds),
      ...(group
        ? {
            group,
            groupOf: (project: string) => blurbs.get(project)?.group ?? "software",
          }
        : {}),
      // On the desktop, phone items (Android playtests) stay out unless asked for.
      ...(phone
        ? { device: "phone" as const }
        : showPhoneItems
          ? {}
          : { device: "desktop" as const }),
    }),
    [machine, projects, kinds, group, blurbs, primaryEnvironmentId, phone, showPhoneItems],
  );
}

/** Open decisions the feed filter shows, in feed order, plus those waiting on the other device. */
export function useFilteredOpenDecisions(): {
  readonly entries: readonly DecisionEntry[];
  readonly elsewhere: number;
  readonly filter: OneFeedFilter;
} {
  const feed = useOpenDecisions();
  const filter = useFeedFilter();
  return useMemo(() => {
    const cards = buildOneFeed({ threads: [], decisions: feed.entries, filter });
    return {
      entries: cards.flatMap((card) =>
        card.kind === "decision" ? [card.decision] : card.decisions,
      ),
      elsewhere: waitingOnOtherDevice(feed.entries, filter),
      filter,
    };
  }, [feed.entries, filter]);
}

const threadDigestsAtom = Atom.family((spec: string) =>
  Atom.make((get): ReadonlyMap<string, ThreadDigest> => {
    const digests = new Map<string, ThreadDigest>();
    if (spec === "") return digests;
    for (const part of spec.split("\u0001")) {
      const separator = part.indexOf("\u0002");
      const environmentId = part.slice(0, separator) as EnvironmentId;
      const result = get(
        decisionEnvironment.threadDigests({ environmentId, input: part.slice(separator + 1) }),
      );
      for (const digest of Option.getOrNull(AsyncResult.value(result)) ?? []) {
        digests.set(`${environmentId}:${digest.threadId}`, digest);
      }
    }
    return digests;
  }),
);

/**
 * Result excerpts and working folders for the threads a feed shows, keyed
 * `environmentId:threadId`. A thread re-reads only when a run of it finishes.
 */
export function useThreadDigests(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly latestRun: { readonly completedAt: string | null } | null;
  }>,
): ReadonlyMap<string, ThreadDigest> {
  const spec = useMemo(() => {
    const byEnvironment = new Map<EnvironmentId, Array<{ id: string; version: string | null }>>();
    for (const thread of threads) {
      const list = byEnvironment.get(thread.environmentId) ?? [];
      list.push({ id: thread.id, version: thread.latestRun?.completedAt ?? null });
      byEnvironment.set(thread.environmentId, list);
    }
    return [...byEnvironment]
      .map(([environmentId, list]) => `${environmentId}\u0002${threadDigestKey(list)}`)
      .join("\u0001");
  }, [threads]);
  return useAtomValue(threadDigestsAtom(spec));
}

const machineBriefsAtom = Atom.family((spec: string) =>
  Atom.make((get): ReadonlyArray<BriefMachine> =>
    spec === ""
      ? []
      : spec.split("\u0001").map((part) => {
          const environmentId = part as EnvironmentId;
          const result = get(decisionEnvironment.brief({ environmentId, input: "brief" }));
          return { environmentId, brief: Option.getOrNull(AsyncResult.value(result)) };
        }),
  ),
);

/** Each machine's brief: what happened there since the owner last looked. */
export function useMachineBriefs(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<BriefMachine> {
  return useAtomValue(machineBriefsAtom(environmentIds.join("\u0001")));
}
