import * as DateTime from "effect/DateTime";
import type {
  EnvironmentId,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  TipId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { resolveT3McpSummaryAction } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import * as Schema from "effect/Schema";

import type { Tip } from "./catalog";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tips stay in the strip in introduction order, newest first; older ones live in Settings. */
export const MAX_DECK_SIZE = 3;

const TipSentEventSchema = Schema.Literals(["shown", "opened", "completed"]);
export type TipSentEvent = typeof TipSentEventSchema.Type;

/** Events older than this are not sent: the server would no longer accept their real time. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;

/** A send not finished after this long was cut off, for example by a closed page. */
const CLAIM_TTL_MS = 60_000;
/** A server that refuses an event this many times, such as one too old to know it, never gets it. */
const MAX_SEND_TRIES = 3;

const TipProgress = Schema.Struct({
  introducedAt: Schema.optionalKey(Schema.Number),
  shownAt: Schema.optionalKey(Schema.Number),
  openedAt: Schema.optionalKey(Schema.Number),
  /** First-time events that are finished: delivered, or dropped because no server may get them. */
  sent: Schema.optionalKey(Schema.Array(TipSentEventSchema)),
  /**
   * First-time events being sent, by claim time. Kept apart from `sent` and from the times
   * above, so a send cut off by a closed page expires and retries without losing when the user
   * met the tip.
   */
  sending: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        at: Schema.Number,
        id: Schema.String,
        /** When the event happened, fixed at the first claim so every retry sends the same. */
        happenedAt: Schema.optionalKey(Schema.Number),
        tries: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
  /** The environment the user first met the tip on. Its events go only there. */
  seenOn: Schema.optionalKey(Schema.String),
  /** Where the user first opened the tip's action, when that was on an environment. */
  openedOn: Schema.optionalKey(Schema.String),
  /** Where the tip was first shown, when that was on an environment. */
  shownOn: Schema.optionalKey(Schema.String),
  dismissedAt: Schema.optionalKey(Schema.Number),
  /** Past spans the tip was hidden, kept a week after a restore so late evidence is judged right. */
  hiddenSpans: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
  /** Earliest time this client saw the user do the thing. Detection never clears it. */
  doneAt: Schema.optionalKey(Schema.Number),
  /** Where that use happened, when it happened on an environment. */
  doneOn: Schema.optionalKey(Schema.String),
  /** The user's own answer in Settings, which wins over detection either way. */
  marked: Schema.optionalKey(Schema.Literals(["tried", "not-tried"])),
});
export type TipProgress = typeof TipProgress.Type;

export const TipsState = Schema.Struct({
  startedAt: Schema.NullOr(Schema.Number),
  activeDay: Schema.NullOr(Schema.String),
  activeDayCount: Schema.Number,
  introducedToday: Schema.Number,
  // String keys so a tip removed in a later release does not fail decoding.
  tips: Schema.Record(Schema.String, TipProgress),
});
export type TipsState = typeof TipsState.Type;

export const EMPTY_TIPS_STATE: TipsState = {
  startedAt: null,
  activeDay: null,
  activeDayCount: 0,
  introducedToday: 0,
  tips: {},
};

export const tipProgress = (state: TipsState, id: TipId): TipProgress => state.tips[id] ?? {};

/** Compares by value; storage encodes fields in schema order, so JSON text is not enough. */
export const sameTipsState = Schema.toEquivalence(TipsState);

/**
 * Claims a first-time event at `now`. Returns the same state when it is finished or another
 * claim is still live; a claim older than the TTL was cut off and can be taken over. A retry
 * keeps the event's id, so the server stores one copy even if an earlier send did land.
 */
export function claimTipSend(
  state: TipsState,
  id: TipId,
  event: TipSentEvent,
  now: number,
  newEventId: () => string,
): TipsState {
  const progress = tipProgress(state, id);
  const claim = progress.sending?.[event];
  if (progress.sent?.includes(event) || (claim !== undefined && now - claim.at < CLAIM_TTL_MS)) {
    return state;
  }
  const tries = claim?.tries ?? 0;
  if (tries >= MAX_SEND_TRIES) return settleTipSend(state, id, event, "finished");
  const happenedAt = claim?.happenedAt ?? tipEventTime(progress, event);
  return updateTipProgress(state, id, (current) => ({
    ...current,
    sending: {
      ...current.sending,
      [event]: {
        at: now,
        id: claim?.id ?? newEventId(),
        ...(happenedAt === undefined ? {} : { happenedAt }),
        ...(tries > 0 ? { tries } : {}),
      },
    },
  }));
}

/** When the user met, opened, or used the tip, for the event about it. */
export const tipEventTime = (progress: TipProgress, event: TipSentEvent) =>
  event === "shown" ? progress.shownAt : event === "opened" ? progress.openedAt : progress.doneAt;

/**
 * Ends a claim. "finished" records the event as done for good. Otherwise the claim is freed for a
 * retry that reuses its id; only a server's refusal counts toward the try limit, so an offline
 * server never uses up an event's tries.
 */
export function settleTipSend(
  state: TipsState,
  id: TipId,
  event: TipSentEvent,
  outcome: "finished" | "refused" | "unreachable",
): TipsState {
  const finished = outcome === "finished";
  return updateTipProgress(state, id, ({ sending, ...current }) => {
    const { [event]: claim, ...rest } = sending ?? {};
    const tries = (claim?.tries ?? 0) + (outcome === "refused" ? 1 : 0);
    const remaining =
      finished || claim === undefined
        ? rest
        : {
            ...rest,
            [event]: {
              at: 0,
              id: claim.id,
              ...(claim.happenedAt === undefined ? {} : { happenedAt: claim.happenedAt }),
              ...(tries > 0 ? { tries } : {}),
            },
          };
    return {
      ...current,
      ...(Object.keys(remaining).length > 0 ? { sending: remaining } : {}),
      ...(finished && !current.sent?.includes(event)
        ? { sent: [...(current.sent ?? []), event] }
        : {}),
    };
  });
}

/**
 * Where an exposure happened: here for the first one; for a repeat, where the first one did,
 * so a retry never moves to the server the user is on now.
 */
export function exposureHappenedOn(
  progress: TipProgress,
  field: "shownAt" | "openedAt",
  current: string | null,
): string | null {
  if (progress[field] === undefined) return current;
  return (field === "openedAt" ? progress.openedOn : (progress.shownOn ?? progress.seenOn)) ?? null;
}

/** The first environment a tip's events go to becomes its home, so they never split. */
export const withTipHome = (progress: TipProgress, target: string): TipProgress =>
  progress.seenOn === undefined ? { ...progress, seenOn: target } : progress;

/**
 * Restoring a hidden tip must not credit use that happened while it was hidden and was not led
 * by opening it: that completion is settled without a send.
 */
export function restoreTip(state: TipsState, id: TipId, now: number): TipsState {
  const { dismissedAt, ...progress } = tipProgress(state, id);
  // Another tab may have restored it already.
  if (dismissedAt === undefined) return state;
  const spans = [...(progress.hiddenSpans ?? []), [dismissedAt, now] as const].filter(
    ([, until]) => now - until <= MAX_EVENT_AGE_MS,
  );
  const { hiddenSpans: _old, ...rest } = progress;
  const restored = updateTipProgress(state, id, () => ({
    ...rest,
    introducedAt: now,
    ...(spans.length > 0 ? { hiddenSpans: spans } : {}),
  }));
  const usedWhileHidden =
    progress.doneAt !== undefined &&
    progress.doneAt >= dismissedAt &&
    openedAtHome(progress) > progress.doneAt;
  return usedWhileHidden ? settleTipSend(restored, id, "completed", "finished") : restored;
}

/**
 * Who gets credit for a dictated transcript: the server that transcribed, when the draft is on
 * it. Otherwise two telemetry choices are involved, so the use stays local.
 */
export const voiceUseCredit = <Id extends string>(
  transcribedOn: Id | null,
  draftOn: Id,
): { readonly on: Id } | "unreported" =>
  transcribedOn !== null && transcribedOn === draftOn ? { on: transcribedOn } : "unreported";

/** True when a claim for `event` is live, so this caller owns the send. */
export const isTipSendLive = (state: TipsState, id: TipId, event: TipSentEvent) =>
  tipProgress(state, id).sending?.[event] !== undefined;

/**
 * Where a tip's event goes: the environment the user first met it on. An action that happened
 * on another environment is not reported anywhere, so each server's telemetry setting covers
 * its own activity. Null means do not send.
 */
export function tipEventTarget(
  progress: TipProgress,
  happenedOn: string | null,
  fallback: string | null = null,
): string | null {
  if (progress.seenOn === undefined) return happenedOn ?? fallback;
  return happenedOn === null || happenedOn === progress.seenOn ? progress.seenOn : null;
}

export interface TipUse {
  readonly at: number;
  /** The environment the use happened on, if any. */
  readonly on?: string | undefined;
}

export interface TipSend {
  readonly tip: TipId;
  readonly event: TipSentEvent;
  readonly target: string;
  /** Same across retries of this event. */
  readonly eventId: string;
}

/** Keeps the earliest use, and where it happened. */
export function recordTipUse(state: TipsState, id: TipId, use: TipUse): TipsState {
  const current = tipProgress(state, id);
  if ((current.doneAt ?? Infinity) <= use.at) return state;
  return updateTipProgress(state, id, ({ doneOn: _doneOn, ...rest }) => ({
    ...rest,
    doneAt: use.at,
    ...(use.on === undefined ? {} : { doneOn: use.on }),
  }));
}

/** When the user first met this tip: in the strip, or by opening its action from Settings. */
const tipSeenAt = (progress: TipProgress) =>
  Math.min(shownAtHome(progress), openedAtHome(progress));

/** When the tip was shown on its home environment; a view elsewhere earns that server nothing. */
const shownAtHome = (progress: TipProgress) =>
  progress.shownOn === undefined || progress.shownOn === progress.seenOn
    ? (progress.shownAt ?? Infinity)
    : Infinity;

/**
 * When the user opened the tip on its home environment. An open elsewhere is not reported to
 * the home server, so it must not earn that server credit either.
 */
const openedAtHome = (progress: TipProgress) =>
  progress.openedOn === undefined || progress.openedOn === progress.seenOn
    ? (progress.openedAt ?? Infinity)
    : Infinity;

export const isTipTried = (progress: TipProgress) =>
  progress.marked === undefined ? progress.doneAt !== undefined : progress.marked === "tried";

export const isTipRetired = (progress: TipProgress) =>
  isTipTried(progress) || progress.dismissedAt !== undefined;

export function updateTipProgress(
  state: TipsState,
  id: TipId,
  update: (progress: TipProgress) => TipProgress,
): TipsState {
  return { ...state, tips: { ...state.tips, [id]: update(tipProgress(state, id)) } };
}

export const tipAgeDays = (state: TipsState, now: number) =>
  state.startedAt === null ? 0 : Math.floor((now - state.startedAt) / DAY_MS);

function localDay(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function clockStart(onboardingCompletedAt: string | null, now: number) {
  const onboarded = onboardingCompletedAt === null ? Number.NaN : Date.parse(onboardingCompletedAt);
  return Number.isFinite(onboarded) && onboarded <= now ? onboarded : now;
}

/** Tips in the strip: introduced, still relevant, newest first. */
export function deriveDeck(
  tips: ReadonlyArray<Tip>,
  state: TipsState,
  isAvailable: (id: TipId) => boolean,
): ReadonlyArray<TipId> {
  return tips
    .filter((tip) => {
      const progress = tipProgress(state, tip.id);
      return progress.introducedAt !== undefined && !isTipRetired(progress) && isAvailable(tip.id);
    })
    .toSorted(
      (a, b) =>
        (tipProgress(state, b.id).introducedAt ?? 0) - (tipProgress(state, a.id).introducedAt ?? 0),
    )
    .slice(0, MAX_DECK_SIZE)
    .map((tip) => tip.id);
}

/**
 * Where the carousel starts: the oldest tip in the strip the user has not seen yet (catalog
 * order breaks ties), so a user who never uses the arrows still sees each tip once.
 */
export function deckStartIndex(
  tips: ReadonlyArray<Tip>,
  deck: ReadonlyArray<TipId>,
  state: TipsState,
): number {
  const order = (id: TipId) => tips.findIndex((tip) => tip.id === id);
  const unseen = deck
    .filter((id) => tipProgress(state, id).shownAt === undefined)
    .toSorted(
      (a, b) =>
        (tipProgress(state, a).introducedAt ?? 0) - (tipProgress(state, b).introducedAt ?? 0) ||
        order(a) - order(b),
    );
  return unseen.length === 0 ? 0 : deck.indexOf(unseen[0]!);
}

/** True when use happened while the tip was hidden (now or in its last hidden span). */
const usedWhileHidden = (progress: TipProgress, doneAt: number) =>
  (progress.dismissedAt !== undefined && progress.dismissedAt <= doneAt) ||
  (progress.hiddenSpans ?? []).some(([from, until]) => from <= doneAt && doneAt <= until);

/**
 * Claims every first-time event still owed: exposures that never got through, then
 * completions. A conversion is use after the user met the tip that the tip led to: not use
 * while it was hidden (unless they opened it first), and not when they said they had not tried
 * it. Events no server may get, or too old to date truly, are settled without a send.
 */
export function claimPendingSends(input: {
  readonly tips: ReadonlyArray<Tip>;
  readonly state: TipsState;
  readonly now: number;
  readonly environmentId: string | null;
  readonly newEventId: () => string;
}): { readonly state: TipsState; readonly sends: ReadonlyArray<TipSend> } {
  const { tips, now } = input;
  let state = input.state;
  const sends: Array<TipSend> = [];
  const claim = (
    tip: TipId,
    event: TipSentEvent,
    happenedOn: string | null,
    happenedAt: number,
  ) => {
    if (tipProgress(state, tip).sent?.includes(event)) return;
    // A retry sends its first claim's time, so that time decides its age too.
    const sentAt = tipProgress(state, tip).sending?.[event]?.happenedAt ?? happenedAt;
    if (now - sentAt > MAX_EVENT_AGE_MS) {
      state = settleTipSend(state, tip, event, "finished");
      return;
    }
    const claimed = claimTipSend(state, tip, event, now, input.newEventId);
    if (claimed === state) return;
    // Out of tries: settled for good without another send.
    if (!isTipSendLive(claimed, tip, event)) {
      state = claimed;
      return;
    }
    const progress = tipProgress(state, tip);
    const target = tipEventTarget(progress, happenedOn, input.environmentId);
    // With nowhere known to send, leave it for a visit that has an environment.
    if (target === null && progress.seenOn === undefined && happenedOn === null) return;
    if (target === null) {
      state = settleTipSend(state, tip, event, "finished");
      return;
    }
    // The first environment a tip's events go to becomes its home, so they never split.
    state = updateTipProgress(claimed, tip, (current) => withTipHome(current, target));
    sends.push({ tip, event, target, eventId: tipProgress(state, tip).sending![event]!.id });
  };
  for (const tip of tips) {
    const progress = tipProgress(state, tip.id);
    if (progress.shownAt !== undefined) {
      claim(tip.id, "shown", progress.shownOn ?? progress.seenOn ?? null, progress.shownAt);
    }
    if (progress.openedAt !== undefined) {
      claim(tip.id, "opened", progress.openedOn ?? null, progress.openedAt);
    }
    const { doneAt } = progress;
    if (
      doneAt === undefined ||
      tipSeenAt(progress) > doneAt ||
      (usedWhileHidden(progress, doneAt) && openedAtHome(progress) > doneAt) ||
      progress.marked === "not-tried"
    )
      continue;
    claim(tip.id, "completed", progress.doneOn ?? null, doneAt);
  }
  return { state, sends };
}

/**
 * One new-thread visit. Records detected use, then introduces new tips: two on the first active
 * day, one on each later one. A user who is away for weeks gets one tip back, not the backlog.
 */
export function planTipsVisit(input: {
  readonly tips: ReadonlyArray<Tip>;
  readonly state: TipsState;
  readonly now: number;
  readonly onboardingCompletedAt: string | null;
  /** Detected use, with when and where it happened. */
  readonly done: ReadonlyMap<TipId, TipUse>;
  readonly isAvailable: (id: TipId) => boolean;
  /** Where events go for a tip met without a known environment: the visit's own. */
  readonly environmentId: string | null;
  readonly newEventId: () => string;
}): {
  readonly state: TipsState;
  /**
   * First-time events this visit claimed, with the environment each goes to: exposures that
   * never got through, then completions. Events no server may get are settled, not listed.
   */
  readonly sends: ReadonlyArray<TipSend>;
} {
  const { tips, now } = input;
  let state = input.state;
  if (state.startedAt === null) {
    state = { ...state, startedAt: clockStart(input.onboardingCompletedAt, now) };
  }
  const today = localDay(now);
  if (state.activeDay !== today) {
    state = {
      ...state,
      activeDay: today,
      activeDayCount: state.activeDayCount + 1,
      introducedToday: 0,
    };
  }

  for (const [id, use] of input.done) state = recordTipUse(state, id, use);
  const pending = claimPendingSends({
    tips,
    state,
    now,
    environmentId: input.environmentId,
    newEventId: input.newEventId,
  });
  state = pending.state;
  const sends = pending.sends;

  const ageDays = tipAgeDays(state, now);
  let quota = (state.activeDayCount === 1 ? 2 : 1) - state.introducedToday;
  for (const tip of tips) {
    if (quota <= 0) break;
    const progress = tipProgress(state, tip.id);
    if (progress.introducedAt !== undefined || isTipRetired(progress)) continue;
    if (ageDays < tip.minAgeDays || !input.isAvailable(tip.id)) continue;
    state = updateTipProgress(state, tip.id, (current) => ({ ...current, introducedAt: now }));
    state = { ...state, introducedToday: state.introducedToday + 1 };
    quota -= 1;
  }
  return { state, sends };
}

export interface TipEvidence {
  /** When settings-based evidence is observed; shells carry their own creation time. */
  readonly now: number;
  readonly boringSidebarEnabled: boolean;
  /** Connected environments on another machine than this client's own (not its local backends). */
  readonly remoteEnvironmentCount: number;
  readonly shells: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "environmentId"
      | "id"
      | "providerInstanceId"
      | "lineage"
      | "delegatedFrom"
      | "source"
      | "createdAt"
      | "providerInstanceHistory"
      | "latestRun"
    >
  >;
  readonly driverOf: (
    environmentId: EnvironmentId,
    instanceId: string,
  ) => ProviderDriverKind | undefined;
}

/** Turn items that can show a launch: created threads, delegated tasks, and launch tools. */
export type TipEvidenceItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "dynamic_tool" | "subagent" | "thread_created" }
>;

/**
 * Use shown by a timeline item: an agent-started thread (a created thread, or a delegated task
 * in its own thread here or on another computer), and Claude -> Codex when the item started a
 * Codex child from a thread that only ever ran on Claude.
 */
export function turnItemTipUses(
  environmentId: EnvironmentId,
  item: TipEvidenceItem,
  context: {
    readonly parent: Parameters<typeof isAlwaysClaude>[0] | null;
    /** The child thread, when this client has it, to read the provider it started on. */
    readonly child: Pick<
      EnvironmentThreadShell,
      "environmentId" | "providerInstanceHistory" | "forkedFrom"
    > | null;
    /** The parent's runs, to read the provider of the run that started the child. */
    readonly runs: ReadonlyArray<{ readonly id: string; readonly providerInstanceId: string }>;
  },
  driverOf: TipEvidence["driverOf"],
): ReadonlyArray<readonly [TipId, TipUse]> {
  const use = { at: DateTime.toEpochMillis(item.startedAt ?? item.updatedAt), on: environmentId };
  // `t3_thread_launch` starts a parentless thread and leaves only its tool call in this timeline.
  if (item.type === "dynamic_tool") {
    // Name first: parsing every tool's output would cost the timeline on each update.
    return item.status === "completed" &&
      resolveT3McpSummaryAction(item.toolName, item.input) === "thread-create" &&
      launchedThread(item.output)
      ? [["agent-threads", use]]
      : [];
  }
  // A reply to an existing child adds a new card; only the card that started it is a launch.
  // A local child that is not loaded cannot rule out a reply, so its card earns nothing.
  const spawn = context.child?.forkedFrom;
  if (
    item.type === "subagent" &&
    ((spawn?.type === "node" && spawn.nodeId !== item.subagentId) ||
      (item.childThreadId !== null && item.remoteChild === undefined && context.child === null))
  ) {
    return [];
  }
  // A created thread may never run, so it credits only agent threads. Claude -> Codex needs a
  // delegated task, which reports back as the tip promises.
  if (item.type === "thread_created") return [["agent-threads", use]];
  if (item.origin !== "app_owned") return [];
  const uses: Array<readonly [TipId, TipUse]> = [];
  if (item.childThreadId !== null || item.remoteChild !== undefined) {
    uses.push(["agent-threads", use]);
  }
  // The child's first provider: a follow-up after a switch says nothing about how it started.
  const childFirst = context.child?.providerInstanceHistory[0];
  const childDriver =
    childFirst !== undefined && context.child !== null
      ? driverOf(context.child.environmentId, childFirst)
      : item.driver;
  // The run that started the child knows its provider; without it, only an always-Claude
  // parent can be trusted.
  const run = context.runs.find((candidate) => candidate.id === item.runId);
  const starterIsClaude =
    run !== undefined
      ? driverOf(environmentId, run.providerInstanceId) === "claudeAgent"
      : context.parent !== null && isAlwaysClaude(context.parent, driverOf);
  if (childDriver === "codex" && starterIsClaude) uses.push(["claude-codex", use]);
  return uses;
}

/** A launch tool's output names the thread it made; the wire keeps those ids in its summary. */
function launchedThread(output: unknown): boolean {
  const result = compactDynamicToolOutput(output);
  if (result === undefined || result.isError === true || result.status === "rolled_back") {
    return false;
  }
  return (
    result.threadId !== undefined ||
    result.thread !== undefined ||
    (result.threads ?? []).some(
      (thread) => thread.threadId !== undefined && thread.status !== "rolled_back",
    )
  );
}

/**
 * The provider instances, with their machines, that a launch card's Claude -> Codex decision
 * reads: the starter run's, or else every one the parent used, plus the child's first.
 */
export function launchProviderInstances(
  environmentId: EnvironmentId,
  input: {
    readonly run: { readonly providerInstanceId: string } | undefined;
    readonly parent: Pick<
      EnvironmentThreadShell,
      "providerInstanceId" | "providerInstanceHistory"
    > | null;
    readonly child: Pick<
      EnvironmentThreadShell,
      "environmentId" | "providerInstanceHistory"
    > | null;
  },
): ReadonlyArray<readonly [EnvironmentId, string]> {
  const starter =
    input.run !== undefined
      ? [input.run.providerInstanceId]
      : input.parent === null
        ? []
        : [input.parent.providerInstanceId, ...input.parent.providerInstanceHistory];
  const childFirst = input.child?.providerInstanceHistory[0];
  return [
    ...starter.map((instanceId) => [environmentId, instanceId] as const),
    ...(input.child !== null && childFirst !== undefined
      ? [[input.child.environmentId, childFirst] as const]
      : []),
  ];
}

/**
 * Whether reading `item` again can give no new evidence. A launch card waits for what decides
 * Claude -> Codex: who started it (the run, or else the parent shell), the child (`null` when
 * there is none it could load), and providers.
 */
export function isTipEvidenceFinal(
  item: TipEvidenceItem,
  loaded: { readonly parent: boolean; readonly child: boolean | null; readonly providers: boolean },
): boolean {
  if (item.type === "dynamic_tool") return !OPEN_ITEM_STATUSES.has(item.status);
  if (item.type === "thread_created") return true;
  if (!loaded.parent || !loaded.providers) return false;
  // The server leaves out idle child shells, so a finished task's missing child may never load.
  return loaded.child !== false || !OPEN_ITEM_STATUSES.has(item.status);
}

const OPEN_ITEM_STATUSES = new Set(["idle", "pending", "running", "waiting"]);

/** The host in a URL or an address such as `user@host:22`, `host:3773` or `user@::1`. */
export function addressHost(address: string | null): string | null {
  if (address === null || address.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    try {
      const { hostname } = new URL(address);
      if (hostname.length > 0) return hostname.replace(/^\[|\]$/g, "");
    } catch {}
  }
  const host = address.slice(address.lastIndexOf("@") + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? null : host.slice(1, end);
  }
  // Two or more colons is a bare IPv6 address, not host:port.
  if ((host.match(/:/g) ?? []).length >= 2) return host;
  return host.split(":")[0] || null;
}

/**
 * Whether a saved environment is another machine: not this desktop's own backends (native or
 * WSL) and not a loopback host. The primary counts only when the page is served from elsewhere.
 */
export function isRemoteMachine(input: {
  readonly kind: "primary" | "desktop-local" | "other";
  readonly host: string | null;
  readonly desktopApp: boolean;
}): boolean {
  if (input.kind === "desktop-local") return false;
  if (input.kind === "primary" && input.desktopApp) return false;
  // A relay (T3 Connect) environment has no host and is always another machine.
  if (input.host === null) return input.kind === "other";
  return !isLocalLoopbackHost(input.host);
}

/**
 * A thread that only ever ran on Claude. A thread switched to Claude later cannot show that
 * Claude started its children.
 */
export function isAlwaysClaude(
  thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "providerInstanceId" | "providerInstanceHistory"
  >,
  driverOf: TipEvidence["driverOf"],
): boolean {
  return [thread.providerInstanceId, ...thread.providerInstanceHistory].every(
    (instanceId) => driverOf(thread.environmentId, instanceId) === "claudeAgent",
  );
}

/**
 * Tips whose behavior the user already tried, from data the client already holds, with the
 * earliest time each was seen.
 */
export function detectDoneTips(evidence: TipEvidence): ReadonlyMap<TipId, TipUse> {
  const done = new Map<TipId, TipUse>();
  const add = (id: TipId, at: number, on?: string) => {
    if (Number.isFinite(at) && at < (done.get(id)?.at ?? Infinity)) done.set(id, { at, on });
  };
  if (evidence.boringSidebarEnabled) add("boring-sidebar", evidence.now);
  // The use is this client connecting; the event names no machine, so the tip's home may hear.
  if (evidence.remoteEnvironmentCount >= 1) add("other-computers", evidence.now);

  const shellKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;
  const byKey = new Map(
    evidence.shells.map((shell) => [shellKey(shell.environmentId, shell.id), shell]),
  );
  for (const shell of evidence.shells) {
    const at = Date.parse(shell.createdAt);
    // A local parent decides; a child inherits `delegatedFrom` from a parent that was delegated.
    const localParent = shell.lineage.parentThreadId;
    // A delegated thread credits the computer that started it, as its parent's timeline does.
    const on =
      localParent === null
        ? (shell.delegatedFrom?.environmentId ?? shell.environmentId)
        : shell.environmentId;
    if (shell.source.creationSource === "mobile") add("phone-app", at, on);
    if (shell.lineage.sideChat === true) {
      // An empty side chat is unused; the app deletes it when its tab closes.
      if (shell.latestRun !== null) add("side-chats", at, on);
      continue;
    }
    if (shell.source.createdBy !== "agent" || shell.source.creationSource !== "mcp") continue;
    const parent =
      localParent !== null
        ? byKey.get(shellKey(shell.environmentId, localParent))
        : shell.delegatedFrom
          ? byKey.get(shellKey(shell.delegatedFrom.environmentId, shell.delegatedFrom.threadId))
          : undefined;
    // Parentless agent threads also come from outside MCP apps; those are seen through their
    // "Created thread" timeline row instead.
    // A fork has a parent too, and an outside app can make one; only delegated work counts.
    if (shell.lineage.relationshipToParent !== "subagent" && !shell.delegatedFrom) continue;
    add("agent-threads", at, on);
    if (parent === undefined) continue;
    // The child's first provider: a thread switched later says nothing about how it started.
    // Older servers send no history, so the current provider proves nothing there.
    const childFirstInstance = shell.providerInstanceHistory[0];
    if (
      childFirstInstance !== undefined &&
      isAlwaysClaude(parent, evidence.driverOf) &&
      evidence.driverOf(shell.environmentId, childFirstInstance) === "codex"
    ) {
      add("claude-codex", at, on);
    }
  }
  return done;
}
