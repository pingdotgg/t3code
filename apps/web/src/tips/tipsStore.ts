import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import type { ScopedThreadRef, TipAnalyticsInput, TipId } from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
  managedCapabilityDenial,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readThreadShell,
  readThreadShells,
  subscribeThreadShell,
  useAllEnvironmentShellsBootstrapped,
} from "../state/entities";
import { readEnvironment, useEnvironmentProviders } from "../state/environments";
import { environmentPresentations, environmentSummaries } from "../state/presentation";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { readEnvironmentScope } from "../state/session";
import { randomUUID } from "../lib/utils";
import { TIPS } from "./catalog";
import { markTipDone, readTipsState, updateTipsState, writeTipsState } from "./tipsStorage";
import {
  deriveDeck,
  detectDoneTips,
  type TipSentEvent,
  isTipEvidenceFinal,
  tipEventTime,
  launchProviderInstances,
  type TipEvidenceItem,
  type TipUse,
  MAX_EVENT_AGE_MS,
  addressHost,
  isRemoteMachine,
  claimPendingSends,
  claimTipSend,
  exposureHappenedOn,
  isTipSendLive,
  restoreTip,
  withTipHome,
  planTipsVisit,
  settleTipSend,
  tipEventTarget,
  tipProgress,
  turnItemTipUses,
  updateTipProgress,
} from "./tipsState";

const recordTipEventCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:server:record-tip-event",
  tag: WS_METHODS.serverRecordTipEvent,
});

/**
 * Resolves whether the server accepted the event. The server drops it when telemetry is off;
 * older servers reject it.
 */
export async function recordTipEvent(
  environmentId: EnvironmentId | null,
  input: TipAnalyticsInput,
): Promise<TipSendOutcome> {
  // Never guess a target: a primary that is offline would quietly drop the event.
  if (environmentId === null) return "unreachable";
  const result = await runAtomCommand(
    appAtomRegistry,
    recordTipEventCommand,
    { environmentId, input },
    { label: "record tip event", reportFailure: false, reportDefect: false },
  );
  return result._tag === "Success" ? "finished" : failureKind(result);
}

type TipSendOutcome = "finished" | "refused" | "unreachable";

/** A lost connection keeps an event's tries; only an answer from the server refuses it. */
export function failureKind(result: { readonly cause: Cause.Cause<unknown> }): TipSendOutcome {
  if (Cause.hasInterruptsOnly(result.cause)) return "unreachable";
  const error = squashAtomCommandFailure(result);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
  const message = error instanceof Error ? error.message : String(error);
  const transport =
    tag === "EnvironmentRpcUnavailableError" ||
    /Socket|RpcClient|Timeout|Protocol/.test(tag) ||
    isTransportConnectionErrorMessage(message);
  return transport ? "unreachable" : "refused";
}

const newEventId = () => randomUUID();

const isSavedEnvironment = (id: string) =>
  appAtomRegistry.get(environmentSummaries.environmentIdsAtom).some((saved) => saved === id);

const isConnectedEnvironment = (id: string) =>
  appAtomRegistry
    .get(environmentSummaries.connectedEnvironmentIdsAtom)
    .some((connected) => connected === id);

/**
 * Where a tip event from a page with no draft goes: the first connected of `preferred`, else any
 * connected environment. An offline machine must not become a tip's home.
 */
export function tipEventEnvironmentId(
  preferred: ReadonlyArray<EnvironmentId | null | undefined>,
  connected: ReadonlyArray<EnvironmentId> = appAtomRegistry.get(
    environmentSummaries.connectedEnvironmentIdsAtom,
  ),
): EnvironmentId | null {
  return (
    preferred.find((id): id is EnvironmentId => id != null && connected.includes(id)) ??
    connected[0] ??
    null
  );
}

/**
 * Sends a claimed first-time event, only to its target (never rerouted, which would cross that
 * server's telemetry choice). A refusal counts toward the try limit. A target that is offline,
 * not loaded yet, or removed only frees the claim; an event that waits past a week is dropped.
 */
function sendClaimed(id: TipId, event: TipSentEvent, target: string, claimedAt: number) {
  const claim = tipProgress(readTipsState(), id).sending?.[event];
  if (claim?.at !== claimedAt) return;
  const settle = (outcome: TipSendOutcome) =>
    updateTipsState((state) =>
      tipProgress(state, id).sending?.[event]?.at === claimedAt
        ? settleTipSend(state, id, event, outcome)
        : state,
    );
  // The time fixed at the first claim, so a retry never sends one event with two dates.
  const at = claim.happenedAt ?? tipEventTime(tipProgress(readTipsState(), id), event);
  if (at !== undefined && Date.now() - at > MAX_EVENT_AGE_MS) {
    settle("finished");
    return;
  }
  if (!isConnectedEnvironment(target)) {
    settle("unreachable");
    return;
  }
  void recordTipEvent(EnvironmentId.make(target), {
    event,
    tip: id,
    id: claim.id,
    ...(at === undefined ? {} : { at }),
  }).then(settle);
}

/**
 * Sends a tip action, such as hide or "Tried it", where the tip's events go, or nowhere. The
 * first environment it goes to becomes the tip's home, as an exposure would make it.
 */
function sendTipAction(id: TipId, environmentId: EnvironmentId | null, input: TipAnalyticsInput) {
  const target = tipEventTarget(tipProgress(readTipsState(), id), environmentId);
  if (target === null || !isSavedEnvironment(target)) return;
  updateTipsState((state) =>
    updateTipProgress(state, id, (current) => withTipHome(current, target)),
  );
  void recordTipEvent(EnvironmentId.make(target), input);
}

/** Stamps when and where the user met the tip (kept forever) and sends its event once. */
function recordExposure(
  id: TipId,
  field: "shownAt" | "openedAt",
  event: "shown" | "opened",
  environmentId: EnvironmentId | null,
) {
  const at = Date.now();
  let target: string | null = null;
  const saved = updateTipsState((state) => {
    const happenedOn = exposureHappenedOn(tipProgress(state, id), field, environmentId);
    const stamped = updateTipProgress(state, id, (current) => ({
      ...current,
      ...(current[field] === undefined ? { [field]: at } : {}),
      ...(current.seenOn === undefined && environmentId !== null ? { seenOn: environmentId } : {}),
      ...(current[field] === undefined && environmentId !== null
        ? { [field === "openedAt" ? "openedOn" : "shownOn"]: environmentId }
        : {}),
    }));
    // With no environment at all, a later visit sends it from one.
    if (happenedOn === null && tipProgress(stamped, id).seenOn === undefined) return stamped;
    const claimed = claimTipSend(stamped, id, event, at, newEventId);
    if (claimed === stamped || !isTipSendLive(claimed, id, event)) return claimed;
    target = tipEventTarget(tipProgress(stamped, id), happenedOn);
    return target === null ? settleTipSend(stamped, id, event, "finished") : claimed;
  });
  // Only the call whose claim storage kept sends; another call or tab owns any other claim.
  if (saved && target !== null) sendClaimed(id, event, target, at);
}

const NO_CONTEXT = { parent: null, child: null, runs: [] } as const;

type Runs = ReadonlyArray<{ readonly id: string; readonly providerInstanceId: string }>;

// Items that can give no new evidence, so each is read once while the thread keeps updating.
const settledItems = new WeakSet<TipEvidenceItem>();

/** Records what `item` shows; returns the thread shells it still waits for. */
function recordTurnItemTipEvidence(
  environmentId: EnvironmentId,
  item: TipEvidenceItem,
  runs: Runs,
  providers: ReadonlyMap<EnvironmentId, ReadonlyArray<{ readonly instanceId: string }>>,
): ReadonlyArray<ScopedThreadRef> {
  if (settledItems.has(item)) return [];
  if (item.type !== "subagent" || item.origin !== "app_owned") {
    for (const [id, use] of turnItemTipUses(environmentId, item, NO_CONTEXT, driverOf)) {
      markTipDone(id, { at: use.at, on: environmentId });
    }
    // A running tool settles on its next status update; it waits on no shell.
    if (isTipEvidenceFinal(item, { parent: true, child: null, providers: true })) {
      settledItems.add(item);
    }
    return [];
  }
  // A child on another machine is found there, with that machine's providers.
  const childRef =
    item.remoteChild !== undefined
      ? scopeThreadRef(item.remoteChild.environmentId, item.remoteChild.threadId)
      : item.childThreadId === null
        ? null
        : scopeThreadRef(environmentId, item.childThreadId);
  const parentRef = scopeThreadRef(environmentId, item.threadId);
  const context = {
    parent: readThreadShell(parentRef),
    child: childRef === null ? null : readThreadShell(childRef),
    runs,
  };
  for (const [id, use] of turnItemTipUses(environmentId, item, context, driverOf)) {
    markTipDone(id, { at: use.at, on: environmentId });
  }
  // A child on a machine that is not saved can never load.
  const loadable = childRef !== null && isSavedEnvironment(childRef.environmentId);
  // The run that started the child answers who started it; the parent is only the fallback.
  const run = runs.find((candidate) => candidate.id === item.runId);
  const starterKnown = context.parent !== null || run !== undefined;
  // Every provider instance the decision reads must resolve; a cached list may lack one.
  const needed = launchProviderInstances(environmentId, {
    run,
    parent: context.parent,
    child: loadable ? context.child : null,
  });
  const final = isTipEvidenceFinal(item, {
    parent: starterKnown,
    child: loadable ? context.child !== null : null,
    providers: needed.every(([on, instanceId]) =>
      providers.get(on)?.some((provider) => provider.instanceId === instanceId),
    ),
  });
  if (final) {
    settledItems.add(item);
    return [];
  }
  return [
    ...(starterKnown ? [] : [parentRef]),
    ...(loadable && context.child === null ? [childRef] : []),
  ];
}

/**
 * Records tip evidence from every loaded turn item, so collapsed groups that never render their
 * rows still count. Pass the quiet items, which hold still while replies stream.
 */
export function useTurnItemTipEvidence(
  environmentId: EnvironmentId,
  visibleItems: ReadonlyArray<{ readonly item: { readonly type: string } }>,
  runs: Runs,
) {
  // Providers and shells that load later can complete a pending launch card.
  const providers = useEnvironmentProviders();
  const shellsReady = useAllEnvironmentShellsBootstrapped();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records feature use in localStorage and waits on child shells in the atom registry
  useEffect(() => {
    if (!shellsReady) return;
    const scan = () => {
      const waiting = new Map<string, ScopedThreadRef>();
      for (const { item } of visibleItems) {
        if (!isTipEvidenceItem(item)) continue;
        for (const ref of recordTurnItemTipEvidence(environmentId, item, runs, providers)) {
          waiting.set(`${ref.environmentId}:${ref.threadId}`, ref);
        }
      }
      return waiting;
    };
    // A thread that lands after its card is read once, then no longer watched.
    const stops = [...scan().values()].map((ref) => {
      const stop = subscribeThreadShell(ref, (shell) => {
        if (shell === null) return;
        stop();
        scan();
      });
      // It may have landed between the scan and the subscribe.
      if (readThreadShell(ref) !== null) {
        stop();
        scan();
      }
      return stop;
    });
    return () => {
      for (const stop of stops) stop();
    };
  }, [environmentId, visibleItems, runs, providers, shellsReady]);
}

const isTipEvidenceItem = (item: { readonly type: string }): item is TipEvidenceItem =>
  item.type === "dynamic_tool" || item.type === "subagent" || item.type === "thread_created";

/** One `opened` per tip on this device, not one per click. */
export function markTipOpened(id: TipId, environmentId: EnvironmentId | null) {
  recordExposure(id, "openedAt", "opened", environmentId);
}

export function markTipShown(id: TipId, environmentId: EnvironmentId | null) {
  recordExposure(id, "shownAt", "shown", environmentId);
}

/** Returns false when storage refused the change, so the caller can leave the tip as it was. */
export function setTipDismissed(
  id: TipId,
  dismissed: boolean,
  environmentId: EnvironmentId | null,
): boolean {
  const now = Date.now();
  const result = writeTipsState((state) =>
    dismissed
      ? // Another tab may have hidden it already; the first time is when use stops counting.
        updateTipProgress(state, id, (current) => ({
          ...current,
          dismissedAt: current.dismissedAt ?? now,
        }))
      : // Restoring also puts the tip back at the front of the strip.
        restoreTip(state, id, now),
  );
  if (result === "saved") {
    sendTipAction(id, environmentId, { event: dismissed ? "dismissed" : "restored", tip: id });
  }
  return result !== "failed";
}

/**
 * The user's own "Tried it" answer in Settings. "Not tried" is kept only to override detected
 * use; with nothing detected, clearing the box hands the tip back to detection.
 */
export function setTipTried(id: TipId, tried: boolean, environmentId: EnvironmentId | null) {
  const before = tipProgress(readTipsState(), id).marked;
  const saved = updateTipsState((state) =>
    updateTipProgress(state, id, ({ marked: _marked, ...current }) =>
      tried
        ? { ...current, marked: "tried" }
        : current.doneAt === undefined
          ? current
          : { ...current, marked: "not-tried" },
    ),
  );
  if (!saved) return;
  const marked = tipProgress(readTipsState(), id).marked;
  // Clearing a manual check takes back its "tried" answer.
  if (marked === undefined && before !== "tried") return;
  sendTipAction(id, environmentId, {
    event: marked === "tried" ? "marked_tried" : "marked_not_tried",
    tip: id,
  });
}

/** Adds a tip to the strip from Settings; it shows on the next new thread. */
export function showTipNow(id: TipId) {
  updateTipsState((state) =>
    updateTipProgress(state, id, (current) => ({ ...current, introducedAt: Date.now() })),
  );
}

function driverOf(environmentId: EnvironmentId, instanceId: string) {
  return appAtomRegistry
    .get(environmentPresentations.providersByEnvironmentAtom)
    .get(environmentId)
    ?.find((provider) => provider.instanceId === instanceId)?.driver;
}

/**
 * Whether a tip can work from this client and environment. Unknown counts as no.
 * `readyDrivers` narrows provider checks to the draft's project when the caller knows them.
 * `sources` lets a component pass the values it subscribes to, so its labels follow them.
 */
export function isTipAvailable(
  id: TipId,
  environmentId: EnvironmentId | null,
  readyDrivers?: ReadonlySet<string>,
  sources: {
    readonly providers: ReturnType<typeof readProvidersByEnvironment>;
    readonly configs: ReturnType<typeof readServerConfigs>;
    /** Whether this client may send on an environment (operate scope). */
    readonly canOperate: (environmentId: EnvironmentId) => boolean;
  } = {
    providers: readProvidersByEnvironment(),
    configs: readServerConfigs(),
    canOperate: (environmentId) =>
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  },
): boolean {
  const { providers: providersByEnvironment, configs } = sources;
  // Tips that ask an agent to do something need a connection that may send.
  const canOperate = (environmentId: EnvironmentId | null) =>
    environmentId !== null && sources.canOperate(environmentId);
  switch (id) {
    case "voice-input":
      // The tip is about local models, so some connected environment this client may dictate
      // on must be able to run one.
      // The same browser support the recorder needs.
      return (
        typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof AudioWorkletNode !== "undefined" &&
        appAtomRegistry
          .get(environmentSummaries.connectedEnvironmentIdsAtom)
          .some(
            (connected) =>
              configs.get(connected)?.environment.capabilities.voiceTranscription === true &&
              canOperate(connected),
          )
      );
    case "agent-threads":
      return canOperate(environmentId);
    case "claude-codex": {
      if (!canOperate(environmentId)) return false;
      const providers =
        environmentId === null ? undefined : providersByEnvironment.get(environmentId);
      const ready = (driver: string) =>
        readyDrivers?.has(driver) ??
        providers?.some(
          (provider) =>
            provider.driver === driver && provider.enabled && provider.status === "ready",
        ) === true;
      return ready("claudeAgent") && ready("codex");
    }
    case "phone-app":
    case "mcp-apps": {
      // A phone and hosted MCP apps are remote clients; policy can forbid them.
      const config = environmentId === null ? undefined : configs.get(environmentId);
      return (
        config !== undefined &&
        managedCapabilityDenial(config.managedPolicy, "remoteClients") === undefined
      );
    }
    case "side-chats":
      return (
        environmentId !== null &&
        canOperate(environmentId) &&
        configs.get(environmentId)?.environment.capabilities.sideChats === true
      );
    default:
      return true;
  }
}

const readProvidersByEnvironment = () =>
  appAtomRegistry.get(environmentPresentations.providersByEnvironmentAtom);
const readServerConfigs = () => appAtomRegistry.get(environmentPresentations.serverConfigsAtom);

/** Reads what the user already tried. Snapshots only; a draft never subscribes to every thread. */
export function recordTipEvidence(): ReadonlyMap<TipId, TipUse> {
  const settings = getClientSettings();
  return detectDoneTips({
    now: Date.now(),
    boringSidebarEnabled: settings.boringSidebarEnabled,
    remoteEnvironmentCount: remoteEnvironmentCount(),
    shells: readThreadShells(),
    driverOf,
  });
}

/** Sends events after a use was saved. Only a connected machine may become a tip's home. */
export function sendPendingTipUseEvents(on: EnvironmentId | null) {
  sendPendingTipEvents(on !== null && isConnectedEnvironment(on) ? on : null);
}

/**
 * Sends events still owed without a new-thread visit, for example after Settings records use
 * while the strip is off.
 */
export function sendPendingTipEvents(environmentId: EnvironmentId | null) {
  let pending: ReturnType<typeof claimPendingSends> | undefined;
  const now = Date.now();
  const saved = updateTipsState((state) => {
    pending = claimPendingSends({ tips: TIPS, state, now, environmentId, newEventId });
    return pending.state;
  });
  if (!saved || pending === undefined) return;
  for (const { tip, event, target } of pending.sends) sendClaimed(tip, event, target, now);
}

/** Connected environments on another machine. A saved machine that never connected is not use. */
function remoteEnvironmentCount(): number {
  return appAtomRegistry
    .get(environmentSummaries.connectedEnvironmentIdsAtom)
    .filter((environmentId) => {
      const environment = readEnvironment(environmentId);
      if (environment === null) return false;
      const { target } = environment.entry;
      return isRemoteMachine({
        kind:
          target._tag === "PrimaryConnectionTarget"
            ? "primary"
            : isDesktopLocalConnectionTarget(target)
              ? "desktop-local"
              : "other",
        host: addressHost(
          target._tag === "PrimaryConnectionTarget" ? target.httpBaseUrl : environment.displayUrl,
        ),
        desktopApp: window.desktopBridge !== undefined,
      });
    }).length;
}

/** One new-thread visit: records evidence, introduces due tips, and returns the strip. */
export function runTipsVisit(
  environmentId: EnvironmentId | null,
  readyDrivers?: ReadonlySet<string>,
): ReadonlyArray<TipId> {
  const isAvailable = (id: TipId) => isTipAvailable(id, environmentId, readyDrivers);
  const done = recordTipEvidence();
  const onboardingCompletedAt = getClientSettings().onboardingCompletedAt;
  let visit: ReturnType<typeof planTipsVisit> | undefined;
  const now = Date.now();
  const result = writeTipsState((state) => {
    visit = planTipsVisit({
      tips: TIPS,
      state,
      now,
      onboardingCompletedAt,
      done,
      isAvailable,
      environmentId,
      newEventId,
    });
    return visit.state;
  });
  // A plan storage did not keep would show again on every draft; show nothing instead.
  if (visit === undefined || result === "failed") return [];
  // The plan claimed each send; send only claims storage kept, or a later visit repeats them.
  if (result === "saved") {
    for (const { tip, event, target } of visit.sends) {
      sendClaimed(tip, event, target, now);
    }
  }
  return deriveDeck(TIPS, visit.state, isAvailable);
}
