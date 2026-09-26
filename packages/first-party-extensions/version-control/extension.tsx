import {
  prsReadApi,
  prsWriteApi,
  uiNotificationsApi,
  uiThemeApi,
  vcsActionsApi,
  vcsChangesApi,
  vcsRefsApi,
  vcsRepositoryApi,
  vcsStatusApi,
  type PrsRef,
  type VcsActionKind,
  type VcsActionsCapabilitiesResult,
  type VcsCapabilitiesResult,
  type VcsChangesListResult,
  type VcsListRefsResult,
  type VcsListRemotesResult,
} from "@t3tools/extension-sdk/catalogue";
import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { Json } from "@t3tools/extension-sdk/contracts";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CHANGE_LANES,
  CONNECTING_STATUS,
  IDLE_MUTATION,
  IDLE_STACKED_PROGRESS,
  COMMIT_FOLLOW_UP,
  MUTATION_TOAST_DISMISS_MS,
  PUBLISH_PROVIDERS,
  applyStackedEvent,
  applyStatusEvent,
  canWorktreeRef,
  describeEntry,
  describeMutation,
  describePublishResult,
  describeRef,
  describeStackedProgress,
  describeStackedResult,
  describeStatus,
  dismissReceiptAfterSeen,
  entryMutation,
  isNotificationDismissal,
  laneCount,
  laneMutation,
  laneTitle,
  lanesFromChanges,
  mutationToastSettle,
  mutationToastStart,
  postFollowUpReceipt,
  stackedChooserReason,
  nextThemeVars,
  numstatFor,
  planCommit,
  planPublish,
  planRefCreate,
  planWorktreeCreate,
  publishOffer,
  publishProviderOption,
  pullState,
  pushState,
  refRows,
  refSwitchState,
  refSwitchTarget,
  releaseMutationReceipt,
  remoteRows,
  repositoryState,
  retainSelection,
  settleMutation,
  stackedActionCommits,
  stackedActionInput,
  stackedActionLabel,
  stackedActionNeedsConfirm,
  stackedFollowUp,
  stackedActionOffers,
  stackedActionSuggestion,
  startMutation,
  worktreeRows,
  VCS_PATHS_MAX,
  type ChangeLane,
  type ChangeSelection,
  type MutationFollowUp,
  type MutationOp,
  type MutationPhase,
  type PublishProviderKind,
  type StackedActionProgress,
  type StatusModel,
} from "./viewModel.js";
import { PullRequestsPanel } from "./prsPanel.js";

const manifestId = "t3.version-control";

/**
 * The panel binds repository at the frozen floor: every 1.0.0 method is
 * usable there, and the 1.1.0 additions (push/fetch/listRemotes) gate on
 * their `operations` keys — absent on a 1.0.0 host, so controls hide
 * instead of erroring.
 */
const REPOSITORY_API_RANGE = "^1.0.0";

interface RestoredState {
  readonly selectedPath?: string;
  readonly selectedLane?: string;
  readonly view?: string;
  readonly prHost?: string;
  readonly prRepository?: string;
  readonly prNumber?: number;
}

const LANES = new Set<string>(CHANGE_LANES);
const VIEWS = new Set(["pull-requests", "repository"]);

function restoreState(value: unknown): value is RestoredState | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ["selectedPath", "selectedLane", "view", "prHost", "prRepository", "prNumber"].includes(key),
    ) &&
    (record.selectedPath === undefined || typeof record.selectedPath === "string") &&
    (record.selectedLane === undefined ||
      (typeof record.selectedLane === "string" && LANES.has(record.selectedLane))) &&
    (record.view === undefined || (typeof record.view === "string" && VIEWS.has(record.view))) &&
    (record.prHost === undefined || typeof record.prHost === "string") &&
    (record.prRepository === undefined || typeof record.prRepository === "string") &&
    (record.prNumber === undefined || typeof record.prNumber === "number")
  );
}

/** One-shot capability read; the repository gate decides what the panel may show. */
function useCapabilities(host: ClientHost, session: ViewSession, visible: boolean, tick: number) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: VcsCapabilitiesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsRepositoryApi, host, session.context, REPOSITORY_API_RANGE)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          if (!signal.aborted) setResult({ key: tick, capabilities, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult({
              key: tick,
              capabilities: null,
              error: error instanceof Error ? error.message : "Capabilities unavailable",
            });
        },
      );
    return () => controller.abort();
  }, [host, session, visible, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * Live status via the public `t3.vcs/status` stream. A `closed`
 * frame or a dropped stream is recoverable — each fresh subscription
 * starts from a new snapshot — so retries are bounded like the terminal's.
 */
function useStatusStream(host: ClientHost, session: ViewSession, visible: boolean, tick: number) {
  const [model, setModel] = useState<{ key: number; status: StatusModel } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      let status: StatusModel = CONNECTING_STATUS;
      setModel({ key: tick, status });
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
        let closed = false;
        try {
          const stream = bindStreamApi(vcsStatusApi, host, session.context).subscribe(
            "subscribe",
            {},
            signal,
          );
          for await (const frame of stream) {
            if (signal.aborted) return;
            status = applyStatusEvent(status, frame.value);
            setModel({ key: tick, status });
            if (frame.value.kind === "closed") {
              closed = true;
              break;
            }
          }
        } catch (error) {
          if (!signal.aborted)
            setModel({
              key: tick,
              status: {
                ...status,
                stream: "ended",
                detail: error instanceof Error ? error.message : "Status stream unavailable",
              },
            });
          return;
        }
        if (signal.aborted) return;
        if (!closed) {
          setModel({
            key: tick,
            status: { ...status, stream: "ended", detail: "Status stream ended unexpectedly." },
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      if (!signal.aborted)
        setModel({
          key: tick,
          status: { ...status, stream: "ended", detail: "Status stream ended repeatedly." },
        });
    })();
    return () => controller.abort();
  }, [host, session, visible, tick]);
  return model?.key === tick ? model.status : CONNECTING_STATUS;
}

/**
 * One-shot `t3.vcs/actions` capability probe — the composite surface
 * renders only when `actions.run` is declared for the detected driver.
 * A denied `t3.vcs/read` fails the invoke and the controls hide; there
 * is no point drawing a run button whose call cannot even report.
 */
function useVcsActionsCapabilities(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  tick: number,
) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: VcsActionsCapabilitiesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsActionsApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          if (!signal.aborted) setResult({ key: tick, capabilities, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult({
              key: tick,
              capabilities: null,
              error: error instanceof Error ? error.message : "Action capabilities unavailable",
            });
        },
      );
    return () => controller.abort();
  }, [host, session, visible, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * Staging lanes re-read whenever the revision changes — the status
 * stream's `localRevision` for working-tree/HEAD changes plus the panel's
 * `mutationSerial` for index-only mutations (stage/unstage of TRACKED
 * files change no status fingerprint, so the stream stays silent for
 * them — verified VcsStatusBroadcaster.ts:254-349; the untracked lane
 * is different: a staged-untracked path gains real numstat counts and
 * DOES publish localUpdated — the serial covers both, so state stays
 * honest regardless). Freshness is re-read through the
 * contract, never edited locally and never polled.
 */
function useChangesList(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  isRepo: boolean,
  revision: string,
) {
  const [result, setResult] = useState<{
    key: string;
    changes: VcsChangesListResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible || !isRepo || revision === "") return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsChangesApi, host, session.context)
      .invoke("list", {}, signal)
      .then(
        (changes) => {
          if (!signal.aborted) setResult({ key: revision, changes, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult((prev) => ({
              key: revision,
              // A failed re-read keeps the last-good lanes — a settled
              // mutation re-reads every time, so blanking on each settle
              // would flash the panel empty once per click.
              changes: prev?.changes ?? null,
              error: error instanceof Error ? error.message : "Changes list unavailable",
            }));
        },
      );
    return () => controller.abort();
  }, [host, session, visible, isRepo, revision]);
  if (result === null) return { changes: null, error: null };
  // While a newer revision is in flight, keep showing the last payload;
  // its error belongs to the revision that produced it.
  return { changes: result.changes, error: result.key === revision ? result.error : null };
}

/** Branch/ref listing on the same freshness revision as changes. */
function useRefsList(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  isRepo: boolean,
  revision: string,
) {
  const [result, setResult] = useState<{
    key: string;
    refs: VcsListRefsResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible || !isRepo || revision === "") return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsRefsApi, host, session.context)
      .invoke("list", { refKind: "all" }, signal)
      .then(
        (refs) => {
          if (!signal.aborted) setResult({ key: revision, refs, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult((prev) => ({
              key: revision,
              refs: prev?.refs ?? null,
              error: error instanceof Error ? error.message : "Refs list unavailable",
            }));
        },
      );
    return () => controller.abort();
  }, [host, session, visible, isRepo, revision]);
  if (result === null) return { refs: null, error: null };
  return { refs: result.refs, error: result.key === revision ? result.error : null };
}

/**
 * Remote listing (1.1.0) on the same freshness revision — reads only run
 * where the capability gate reported `repository.listRemotes`.
 */
function useRemotesList(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  enabled: boolean,
  revision: string,
) {
  const [result, setResult] = useState<{
    key: string;
    remotes: VcsListRemotesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible || !enabled || revision === "") return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsRepositoryApi, host, session.context, REPOSITORY_API_RANGE)
      .invoke("listRemotes", {}, signal)
      .then(
        (remotes) => {
          if (!signal.aborted) setResult({ key: revision, remotes, error: null });
        },
        (error) => {
          if (!signal.aborted)
            setResult((prev) => ({
              key: revision,
              remotes: prev?.remotes ?? null,
              error: error instanceof Error ? error.message : "Remotes list unavailable",
            }));
        },
      );
    return () => controller.abort();
  }, [host, session, visible, enabled, revision]);
  if (result === null) return { remotes: null, error: null };
  return { remotes: result.remotes, error: result.key === revision ? result.error : null };
}

/**
 * `t3.ui/theme` consumer. `getTokens` resolves the host's *effective* theme —
 * the provider's projection already folds the stored preference, live session
 * overlays, and external previews into the painted state — and each
 * `subscribeState` frame re-reads the tokens, so the panel tracks exactly
 * what the host paints without interpreting overlay semantics itself. The map
 * lands on the view root as `--t3-version-control-*` custom properties; an
 * ungranted or provider-less host yields null and every style falls back to
 * its legacy `var()` chain — the honest degraded path.
 */
function useThemeVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(uiThemeApi, host, session.context);
    const streams = bindStreamApi(uiThemeApi, host, session.context);
    let generation = 0;
    const refresh = () => {
      const at = ++generation;
      void api.invoke("getTokens", {}, signal).then(
        (value) => {
          if (!signal.aborted && at === generation)
            setVars(nextThemeVars({ ok: true, tokens: value.tokens, cssVars: value.cssVars }));
        },
        // A failed read cannot vouch for the last published map — the
        // overrides clear and the panel returns to its legacy chain until a
        // later read succeeds. Only the current generation may clear, so a
        // stale rejection never wipes a newer good map.
        () => {
          if (!signal.aborted && at === generation) setVars(nextThemeVars({ ok: false }));
        },
      );
    };
    refresh();
    void (async () => {
      try {
        for await (const frame of streams.subscribe("subscribeState", {}, signal)) {
          if (signal.aborted) return;
          if (frame.type === "closed") break;
          refresh();
        }
      } catch {
        // A lost stream lands in the same clear path as a clean close.
      }
      // The subscription is gone, so published overrides can silently go
      // stale against the next host theme change — clear them and invalidate
      // any in-flight read rather than painting last-known values.
      if (!signal.aborted) {
        generation++;
        setVars(nextThemeVars({ ok: false }));
      }
    })();
    return () => controller.abort();
  }, [host, session, visible]);
  return vars;
}

/**
 * `t3.ui/notifications` consumer. Native repository mutations report through
 * toast progress (GitActionsControl): a loading toast on start, the same
 * notification updated to success or error on settle — never an inline row.
 * The grant-free `getCapabilities` probe names a provider-less host before
 * any write; a `notify` failure latches the adapter off (a denied grant
 * never recovers within a session). Every delivery loss — rejected `notify`,
 * rejected or unapplied `update` — hands that mutation's receipt back to the
 * inline row through `onReceiptLost`, and a `notification-expired` update
 * (a user-dismissed loading toast) does so without killing the adapter.
 * A success with a follow-up (native's toast CTA) posts a fresh receipt
 * carrying the button instead, since `update` cannot add actions.
 */
interface MutationToast {
  readonly settle: (
    result: { readonly ok: boolean; readonly detail: string },
    followUp?: MutationFollowUp | null,
  ) => void;
}

function useMutationToasts(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  runFollowUp: (action: VcsActionKind) => void,
): {
  readonly begin: (label: string, onReceiptLost: () => void) => MutationToast | null;
} {
  const [toastsLive, setToastsLive] = useState(false);
  const [followUpsLive, setFollowUpsLive] = useState(false);
  const dead = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(uiNotificationsApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          // A latched-dead adapter stays dead across re-probes — a denied
          // grant never recovers within a session.
          if (!signal.aborted && !dead.current) {
            setToastsLive(
              capabilities.operations.notify === true && capabilities.operations.update === true,
            );
            setFollowUpsLive(capabilities.operations.awaitAction === true);
          }
        },
        () => {},
      );
    return () => controller.abort();
  }, [host, session, enabled]);

  const markDead = () => {
    if (dead.current || session.signal.aborted) return;
    dead.current = true;
    setToastsLive(false);
  };

  const begin = (label: string, onReceiptLost: () => void): MutationToast | null => {
    if (!toastsLive || dead.current) return null;
    const api = bindApi(uiNotificationsApi, host, session.context);
    const resource = session.context.resource;
    // The follow-up receipt awaits its loading-toast retraction so a failed
    // dismiss falls back to the in-place update; everything else is
    // fire-and-forget.
    const dismissOrReject = (notificationId: string): Promise<void> =>
      api.invoke("dismiss", { notificationId }, session.signal).then(() => {});
    const dismiss = (notificationId: string) => {
      void dismissOrReject(notificationId).catch(() => {});
    };
    // A thread-anchored toast paints only while its thread is active — the
    // native threadToastData behavior. Targeting fields may only name this
    // context's own scope.
    const target = {
      ...(resource.threadId !== undefined
        ? { anchor: "thread" as const, threadId: resource.threadId }
        : {}),
      ...(resource.projectId !== undefined ? { projectId: resource.projectId } : {}),
    };
    const posted = api
      .invoke("notify", { ...mutationToastStart(label), ...target }, session.signal)
      .then(
        (result) => {
          // A resolution landing after the adapter died posts a loading
          // toast nothing will update — retract it on arrival.
          if (dead.current) dismiss(result.notificationId);
          return result.notificationId;
        },
        () => {
          markDead();
          onReceiptLost();
          return null;
        },
      );
    // The contract's `update` carries no duration, so success receipts are
    // dismissed on a timer — but an unseen receipt must not expire.
    // dismissReceiptAfterSeen mirrors native's dismissAfterVisibleMs: the
    // clock runs only while the receipt can be read — the view is shown
    // and the document is visible and focused. DOM globals are absent only
    // where nothing can paint, so the view's own visibility decides there.
    const receiptSeen = {
      signal: session.signal,
      seen: () =>
        session.visible &&
        (typeof document === "undefined" ||
          typeof window === "undefined" ||
          (document.visibilityState === "visible" && document.hasFocus())),
      onChange: (listener: () => void) => {
        const offView = session.onVisibility(listener);
        if (typeof document === "undefined" || typeof window === "undefined") return offView;
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("focus", listener);
        window.addEventListener("blur", listener);
        return () => {
          offView();
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("focus", listener);
          window.removeEventListener("blur", listener);
        };
      },
    };
    const settleInPlace = (
      notificationId: string,
      result: { readonly ok: boolean; readonly detail: string },
    ) =>
      void api
        .invoke("update", { notificationId, ...mutationToastSettle(label, result) }, session.signal)
        .then(
          ({ applied }) => {
            if (!applied) {
              // The notification never took the patch — the outcome
              // returns to the inline row so it is not silently lost.
              onReceiptLost();
              return;
            }
            if (result.ok)
              dismissReceiptAfterSeen(receiptSeen, MUTATION_TOAST_DISMISS_MS, () =>
                dismiss(notificationId),
              );
          },
          (error) => {
            onReceiptLost();
            // A dismissed toast reports notification-expired — the
            // provider still works, only this receipt goes inline. Any
            // other rejection is delivery loss and latches the adapter.
            if (!isNotificationDismissal(error)) markDead();
          },
        );
    return {
      settle(result, followUp) {
        void posted.then(async (notificationId) => {
          if (notificationId === null) return;
          if (dead.current) {
            // The adapter died after this toast posted — retract the
            // orphaned loading toast and hand the receipt to the row.
            onReceiptLost();
            dismiss(notificationId);
            return;
          }
          // Native's success toast carries its CTA (Push after a commit).
          if (result.ok && followUp && followUpsLive) {
            const replaced = await postFollowUpReceipt(
              {
                notify: (input) => api.invoke("notify", { ...input, ...target }, session.signal),
                dismiss: dismissOrReject,
                awaitAction: (id) =>
                  api.invoke("awaitAction", { notificationId: id }, session.signal),
              },
              notificationId,
              result.detail,
              followUp,
              {
                onPosted: (receiptId) =>
                  dismissReceiptAfterSeen(receiptSeen, MUTATION_TOAST_DISMISS_MS, () =>
                    dismiss(receiptId),
                  ),
                run: runFollowUp,
              },
            );
            if (replaced) return;
          }
          settleInPlace(notificationId, result);
        });
      },
    };
  };
  return { begin };
}

// Every theme-backed value chains a `--t3-version-control-*` hop (published
// on the view root from `t3.ui/theme` tokens) ahead of the legacy host vars.
// When the contract is unavailable the hop never resolves and the legacy
// chain renders.
const border = "1px solid var(--t3-version-control-border, var(--border, #dfe3e8))";
const muted = "var(--t3-version-control-muted-foreground, var(--muted-foreground, #667085))";

/*
 * Native control idiom (cert vcs-3): text-sm ghost controls — transparent at
 * rest, no border — sized like the native panel's controls instead of the
 * shrunken bordered buttons. Keyboard affordance comes from the focus-ring
 * style block on the panel root.
 */
const control = {
  padding: "4px 8px",
  border: "1px solid transparent",
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
} as const;

function VersionControlView(props: { host: ClientHost; session: ViewSession }) {
  const { host, session } = props;
  const [visible, setVisible] = useState(session.visible);
  const [tick, setTick] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<MutationPhase>(IDLE_MUTATION);
  const [mutationSerial, setMutationSerial] = useState(0);
  const [commitMessage, setCommitMessage] = useState("");
  const [stackedChoice, setStackedChoice] = useState<VcsActionKind | null>(null);
  const [featureBranch, setFeatureBranch] = useState(false);
  // Native's default-branch confirmation — set while the continue-or-
  // feature-ref decision is on screen; the run fires only from its
  // buttons.
  const [pendingConfirm, setPendingConfirm] = useState<VcsActionKind | null>(null);
  // A receipt follow-up clicked while another mutation was in flight.
  const [deferredFollowUp, setDeferredFollowUp] = useState<VcsActionKind | null>(null);
  const [stacked, setStacked] = useState<{
    actionId: string;
    model: StackedActionProgress;
  } | null>(null);
  const [newRefName, setNewRefName] = useState("");
  const [newWorktreeName, setNewWorktreeName] = useState("");
  // The publish form — opened from the Sync section's offer; native's
  // PublishRepositoryDialog reduced to the controls its contract input
  // carries (provider, owner/name path, visibility, remote name,
  // protocol).
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishProvider, setPublishProvider] = useState<PublishProviderKind>("github");
  const [publishRepositoryPath, setPublishRepositoryPath] = useState("");
  const [publishVisibility, setPublishVisibility] = useState<"private" | "public">("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocol, setPublishProtocol] = useState<"ssh" | "https">("ssh");
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  // Paths whose plain `worktree remove` already failed — the force retry
  // only appears for those rows (confirm-by-consequence, not a dead
  // always-on hazard).
  const [worktreeRemoveFailures, setWorktreeRemoveFailures] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const inFlight = useRef(false);
  useEffect(() => session.onVisibility(setVisible), [session]);
  const themeVars = useThemeVars(host, session, visible);

  const restored =
    session.restoreState &&
    typeof session.restoreState === "object" &&
    !Array.isArray(session.restoreState)
      ? (session.restoreState as RestoredState)
      : null;
  const [selection, setSelection] = useState<ChangeSelection | null>(() =>
    restored?.selectedPath && restored.selectedLane && LANES.has(restored.selectedLane)
      ? { path: restored.selectedPath, lane: restored.selectedLane as ChangeLane }
      : null,
  );
  // The native surface is a PR browser first; the repository slice is
  // the second tab. Both persist through session.save — one merged
  // blob, since save replaces restoreState wholesale.
  const [view, setView] = useState<"pull-requests" | "repository">(
    restored?.view === "repository" ? "repository" : "pull-requests",
  );
  const [selectedPr, setSelectedPr] = useState<PrsRef | null>(() =>
    restored?.prRepository !== undefined && typeof restored.prNumber === "number"
      ? {
          repository: restored.prRepository,
          number: restored.prNumber,
          ...(restored.prHost !== undefined && restored.prHost !== ""
            ? { host: restored.prHost }
            : {}),
        }
      : null,
  );
  const savedState = useRef<RestoredState>({ ...restored });
  const persist = (patch: Partial<RestoredState>) => {
    const next: Record<string, unknown> = { ...savedState.current, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    savedState.current = next as RestoredState;
    session.save(next as { readonly [key: string]: Json });
  };

  const repositoryVisible = visible && view === "repository";
  // A receipt's follow-up click lands later, so it reads the latest render.
  const runFollowUpRef = useRef<(action: VcsActionKind) => void>(() => {});
  const { begin: beginToast } = useMutationToasts(host, session, repositoryVisible, (action) =>
    runFollowUpRef.current(action),
  );
  const { capabilities, error: capsError } = useCapabilities(
    host,
    session,
    repositoryVisible,
    tick,
  );
  const repo = repositoryState(capabilities, capsError);
  const status = useStatusStream(host, session, repositoryVisible && repo.kind === "ready", tick);
  const actionCaps = useVcsActionsCapabilities(
    host,
    session,
    repositoryVisible && repo.kind === "ready",
    tick,
  );
  const isRepo = status.local?.isRepo === true;
  // The list revision folds the stream's localRevision with the panel's
  // mutationSerial so index-only mutations (stage/unstage emit no stream
  // frame) still re-read the contracts after they settle.
  const listRevision =
    status.localRevision === 0 ? "" : `${status.localRevision}:${mutationSerial}`;
  const changes = useChangesList(host, session, repositoryVisible, isRepo, listRevision);
  const refs = useRefsList(host, session, repositoryVisible, isRepo, listRevision);

  // Per-operation support from the capability gate — each control renders
  // only when its operation exists for the detected driver.
  const ops = repo.kind === "ready" ? repo.capabilities.operations : null;
  const remotes = useRemotesList(
    host,
    session,
    repositoryVisible,
    isRepo && ops?.["repository.listRemotes"] === true,
    listRevision,
  );

  const lanes = useMemo(() => lanesFromChanges(changes.changes?.entries ?? []), [changes.changes]);
  const selected = retainSelection(selection, lanes);
  const selectedEntry =
    selected === null ? null : (lanes[selected.lane].find((e) => e.path === selected.path) ?? null);
  const selectedStat = selected === null ? null : numstatFor(status.local, selected.path);
  const rows = useMemo(() => refRows(refs.refs), [refs.refs]);
  const remoteList = useMemo(() => remoteRows(remotes.remotes), [remotes.remotes]);
  const worktrees = useMemo(() => worktreeRows(rows), [rows]);

  const canStage = ops?.["changes.stage"] === true;
  const canUnstage = ops?.["changes.unstage"] === true;
  const canCommit = ops?.["changes.commit"] === true;
  const canCreateRef = ops?.["refs.create"] === true;
  const canSwitchRef = ops?.["refs.switch"] === true;
  const canPull = ops?.["repository.pull"] === true;
  const canPush = ops?.["repository.push"] === true;
  const canFetch = ops?.["repository.fetch"] === true;
  const canListRemotes = ops?.["repository.listRemotes"] === true;
  const canInit = capabilities?.operations["repository.init"] === true;
  const canCreateWorktree = ops?.["repository.createWorktree"] === true;
  const canRemoveWorktree = ops?.["repository.removeWorktree"] === true;
  const busy = mutation.kind === "running";
  const commit = planCommit(lanes, commitMessage);
  // The composite surface exists only when the host declares actions.run —
  // no run button against a driver the adapter named unsupported.
  const canRunActions = actionCaps.capabilities?.operations["actions.run"] === true;
  // Publish rides the same capability probe — declared only for drivers the
  // adapter serves publishRepository on.
  const canPublish = actionCaps.capabilities?.operations["actions.publishRepository"] === true;
  // The offer tracks repository state: a repo without an "origin" remote
  // (native's menu condition), disabled by name on a detached HEAD.
  const publish = canPublish ? publishOffer(status.local) : { offered: false, disabled: null };
  const publishPlan = planPublish({
    repository: publishRepositoryPath,
    remoteName: publishRemoteName,
  });
  const stackedOffers = useMemo(
    () => stackedActionOffers(status.local, status.remote, lanes, featureBranch),
    [status.local, status.remote, lanes, featureBranch],
  );
  const stackedDefault = stackedActionSuggestion(status.local, status.remote);
  const chosenOffer = stackedOffers.find(
    (offer) => offer.action === (stackedChoice ?? stackedDefault),
  ) ??
    stackedOffers.find((offer) => offer.disabled === null) ?? {
      action: "commit" as const,
      label: stackedActionLabel("commit"),
      disabled: "Repository status pending",
    };
  const chooserReason = stackedChooserReason(chosenOffer, deferredFollowUp, busy);
  const create = planRefCreate(newRefName, rows);
  const currentBranch = rows.find((row) => row.current && row.remote === null)?.name ?? null;
  const pull = pullState(status.local, status.remote);
  const push = pushState(status.local, status.remote);
  const worktreePlan = planWorktreeCreate(newWorktreeName, rows, currentBranch);

  /**
   * Single-flight mutation runner: one invoke at a time (the panel's
   * analog of native's serialized VCS actions), the running label shown
   * while in flight, rejections surfaced by name, and a settled success
   * bumping `mutationSerial` so the lists re-read the real post-mutation
   * state — the stream cannot confirm index-only changes.
   */
  const runMutation = (
    op: MutationOp,
    label: string,
    invoke: (
      signal: AbortSignal,
    ) => Promise<string | { readonly detail: string; readonly followUp: MutationFollowUp | null }>,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeferredFollowUp(null);
    // The toast begins before the phase update so the receipt channel is
    // recorded on the running phase itself: a mutation that could not start
    // a notification keeps the inline row even if the capability probe
    // resolves mid-flight, and a toast that later fails hands the receipt
    // back through releaseMutationReceipt.
    const toast = beginToast(label, () => setMutation(releaseMutationReceipt(op)));
    // The ref is the synchronous guard; startMutation is the same
    // single-flight rule expressed on the visible phase.
    setMutation(
      (phase) =>
        startMutation(phase, op, label, toast === null ? "inline" : "notification") ?? phase,
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    invoke(signal)
      .then(
        (settled) => {
          const { detail, followUp } =
            typeof settled === "string" ? { detail: settled, followUp: null } : settled;
          setMutation((phase) => settleMutation(phase, op, { ok: true, detail }));
          toast?.settle({ ok: true, detail }, followUp);
        },
        (error) => {
          const detail = error instanceof Error ? error.message : "operation unavailable";
          setMutation((phase) =>
            settleMutation(phase, op, { ok: false, detail: `${label} failed: ${detail}` }),
          );
          toast?.settle({ ok: false, detail });
        },
      )
      .finally(() => {
        inFlight.current = false;
        controller.abort();
        // Every settled mutation re-reads the lists — even a rejected one,
        // since a chunked bulk op may have partially applied before failing.
        setMutationSerial((value) => value + 1);
      });
  };

  const runPaths = (op: "stage" | "unstage", paths: readonly string[], label: string) =>
    runMutation(op, label, async (signal) => {
      const changesApi = bindApi(vcsChangesApi, host, session.context);
      for (let index = 0; index < paths.length; index += VCS_PATHS_MAX) {
        await changesApi.invoke(op, { paths: paths.slice(index, index + VCS_PATHS_MAX) }, signal);
      }
      const noun = `${paths.length} path${paths.length === 1 ? "" : "s"}`;
      return op === "stage" ? `Staged ${noun}` : `Unstaged ${noun}`;
    });

  const runCommit = () => {
    const plan = planCommit(lanes, commitMessage);
    if (plan.disabled !== null) return;
    const message = commitMessage.trim();
    runMutation("commit", "Committing", (signal) =>
      bindApi(vcsChangesApi, host, session.context)
        .invoke(
          "commit",
          plan.paths === undefined ? { message } : { message, paths: [...plan.paths] },
          signal,
        )
        .then((result) => {
          setCommitMessage("");
          return {
            detail: `Committed ${result.commitSha.slice(0, 12)}${
              result.refName !== null ? ` on ${result.refName}` : ""
            }`,
            // The follow-up runs through the stacked runner, as native's does.
            followUp: canRunActions ? COMMIT_FOLLOW_UP : null,
          };
        }),
    );
  };

  /**
   * The stacked composite (t3.vcs/actions): `run` mints the actionId
   * server-side, then the `actionProgress` stream carries phases until a
   * terminal event — the invoke's promise only settles once that stream
   * does, so the single-flight mutation line IS the action's truth.
   * Blank commitMessage keeps native leave-blank auto-generate semantics;
   * a staged subset scopes the commit phase like `planCommit` does.
   */
  const runStacked = (
    offer: { action: VcsActionKind; label: string; disabled: string | null },
    options?: { featureBranch?: boolean },
  ) => {
    if (offer.disabled !== null) return;
    setPendingConfirm(null);
    const message = commitMessage.trim();
    const stagedPaths = lanes.staged.map((entry) => entry.path);
    runMutation("stacked", offer.label, async (signal) => {
      const api = bindApi(vcsActionsApi, host, session.context);
      const { actionId } = await api.invoke(
        "run",
        // stackedActionInput drops featureBranch/paths on actions without
        // a commit phase — the service rejects those combinations.
        stackedActionInput({
          action: offer.action,
          commitMessage: message,
          featureBranch: options?.featureBranch ?? featureBranch,
          stagedPaths,
        }),
        signal,
      );
      let model = IDLE_STACKED_PROGRESS;
      setStacked({ actionId, model });
      const stream = bindStreamApi(vcsActionsApi, host, session.context).subscribe(
        "actionProgress",
        { actionId },
        signal,
      );
      // Read to settlement, not just `action_finished` — the detached
      // post-service recheck can still append `closed` naming a revoked
      // grant after the phase terminal.
      for await (const frame of stream) {
        model = applyStackedEvent(model, frame.value);
        setStacked({ actionId, model });
      }
      if (model.failure !== null)
        throw new Error(
          model.failure.phase === null
            ? model.failure.message
            : `Failed during ${model.failure.phase}: ${model.failure.message}`,
        );
      if (model.closed === "overflow")
        throw new Error("Action progress overflowed — result unknown");
      if (model.closed === "authorization-revoked")
        throw new Error(
          "Authorization was revoked at the post-action check — the action's effects may have persisted",
        );
      if (model.result === null) throw new Error("Action progress ended before the action settled");
      // Clear the box only when this action consumed the input and the
      // author hasn't typed something new during the run — a push-only
      // success must not erase an unrelated draft.
      if (stackedActionCommits(offer.action))
        setCommitMessage((current) => (current === commitMessage ? "" : current));
      return {
        detail: describeStackedResult(model.result),
        followUp: stackedFollowUp(model.result),
      };
    });
  };

  const runCreateRef = () => {
    const plan = planRefCreate(newRefName, rows);
    if (plan.refName === null) return;
    const refName = plan.refName;
    runMutation("ref-create", `Creating branch ${refName}`, (signal) =>
      bindApi(vcsRefsApi, host, session.context)
        .invoke("create", { refName, switchRef: true }, signal)
        .then((result) => {
          setNewRefName("");
          return `Created and switched to ${result.refName}`;
        }),
    );
  };

  const runSwitchRef = (refName: string) =>
    runMutation("ref-switch", `Switching to ${refName}`, (signal) =>
      bindApi(vcsRefsApi, host, session.context)
        .invoke("switch", { refName }, signal)
        .then((result) => `Switched to ${result.refName ?? refName}`),
    );

  const repository = () => bindApi(vcsRepositoryApi, host, session.context, REPOSITORY_API_RANGE);

  const runPull = () =>
    runMutation("pull", "Pulling", (signal) =>
      repository()
        .invoke("pull", {}, signal)
        .then((result) =>
          result.status === "pulled"
            ? `Pulled ${result.refName} from ${result.upstreamRef ?? "upstream"}`
            : "Already up to date",
        ),
    );

  const runPush = () =>
    runMutation("push", "Pushing", (signal) =>
      repository()
        .invoke("push", {}, signal)
        .then((result) =>
          result.status === "pushed"
            ? `Pushed ${result.refName}${
                result.upstreamRef !== null ? ` → ${result.upstreamRef}` : ""
              }${result.setUpstream ? " (upstream set)" : ""}`
            : "Already up to date",
        ),
    );

  const runFetch = (remoteName?: string) =>
    runMutation(
      "fetch",
      remoteName === undefined ? "Fetching all remotes" : `Fetching ${remoteName}`,
      (signal) =>
        repository()
          .invoke("fetch", remoteName === undefined ? {} : { remoteName }, signal)
          .then((result) => `Fetched ${result.remotes.join(", ")}`),
    );

  const runInit = () =>
    runMutation("init", "Initializing repository", (signal) =>
      repository()
        .invoke("init", {}, signal)
        .then(() => {
          // Re-read the capability gate so the panel transitions to the
          // ready state on real detection, not a faked local flip.
          setTick((value) => value + 1);
          return "Initialized a Git repository";
        }),
    );

  /**
   * `actions.publishRepository` — the submit behind the publish offer.
   * One unary invoke does the whole native flow (create the host
   * repository, wire the remote, push the current branch); the settled
   * mutationSerial re-read makes the new remote/upstream show up on real
   * state, and the offer disappears once `hasPrimaryRemote` flips.
   */
  const runPublish = () => {
    if (publishPlan.disabled !== null || publishPlan.repository === null) return;
    const repository = publishPlan.repository;
    const remoteName = publishPlan.remoteName;
    runMutation("publish", "Publishing repository", (signal) =>
      bindApi(vcsActionsApi, host, session.context)
        .invoke(
          "publishRepository",
          {
            provider: publishProvider,
            repository,
            visibility: publishVisibility,
            remoteName,
            protocol: publishProtocol,
          },
          signal,
        )
        .then((result) => {
          // The publish consumed the form — close it; the mutation
          // receipt and the re-read remotes/refs carry the outcome.
          setPublishOpen(false);
          return describePublishResult(result);
        }),
    );
  };

  const runCreateWorktree = (plan: {
    refName: string;
    newRefName?: string;
    baseRefName?: string;
  }) =>
    runMutation("worktree-create", `Creating worktree`, (signal) =>
      repository()
        .invoke(
          "createWorktree",
          {
            refName: plan.refName,
            path: null,
            ...(plan.newRefName === undefined ? {} : { newRefName: plan.newRefName }),
            ...(plan.baseRefName === undefined || plan.baseRefName === null
              ? {}
              : { baseRefName: plan.baseRefName }),
          },
          signal,
        )
        .then((result) => {
          setNewWorktreeName("");
          return `Created worktree ${result.worktree.path} (${result.worktree.refName})`;
        }),
    );

  const runRemoveWorktree = (path: string, force: boolean) =>
    runMutation("worktree-remove", `Removing worktree`, (signal) =>
      repository()
        .invoke("removeWorktree", force ? { path, force: true } : { path }, signal)
        .then(
          () => `Removed worktree ${path}`,
          (error) => {
            setWorktreeRemoveFailures((prev) => new Set(prev).add(path));
            throw error;
          },
        ),
    );

  const refresh = () => {
    // status.refresh is a declared read (effect:"read", t3.vcs/read); the
    // recompute lands back on the stream and bumps localRevision, which
    // re-reads the lists. The tick covers hosts whose refresh changes
    // nothing observable.
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsStatusApi, host, session.context)
      .invoke("refresh", {}, signal)
      .then(
        () => setRefreshError(null),
        (error) =>
          setRefreshError(error instanceof Error ? error.message : "Status refresh unavailable"),
      )
      .finally(() => controller.abort());
    setTick((value) => value + 1);
  };

  const select = (path: string, lane: ChangeLane) => {
    setSelection({ path, lane });
    persist({ selectedPath: path, selectedLane: lane });
  };

  const selectPr = (ref: PrsRef | null) => {
    setSelectedPr(ref);
    persist(
      ref === null
        ? { prHost: undefined, prRepository: undefined, prNumber: undefined }
        : {
            prHost: ref.host ?? undefined,
            prRepository: ref.repository,
            prNumber: ref.number,
          },
    );
  };

  const switchView = (next: "pull-requests" | "repository") => {
    setView(next);
    persist({ view: next });
  };

  /**
   * A receipt's follow-up click — native's CTA re-enters its action runner:
   * the same default-ref confirmation, then the same stacked run as picking
   * the action in the chooser. A blocked offer — or one held back by another
   * in-flight mutation — stays selected there, so its reason shows beside
   * Run instead of the click doing nothing.
   */
  useEffect(() => {
    runFollowUpRef.current = (action) => {
      switchView("repository");
      setStackedChoice(action);
      setPendingConfirm(null);
      const offer = stackedOffers.find((entry) => entry.action === action);
      if (offer === undefined || offer.disabled !== null) return;
      if (inFlight.current) {
        setDeferredFollowUp(action);
        return;
      }
      if (stackedActionNeedsConfirm(action, status.local, featureBranch)) setPendingConfirm(action);
      else runStacked(offer);
    };
  });

  return (
    <section
      aria-label="Version Control"
      data-t3-version-control-panel
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--t3-version-control-text, var(--foreground, #20252d))",
        background: "var(--t3-version-control-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        ...themeVars,
      }}
    >
      {/* Native focus treatment: the host's 2px accent ring with a 1px canvas
          gap on focus-visible (same rule as the other first-party panels). */}
      <style>
        {`[data-t3-version-control-panel] :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 1px var(--t3-version-control-canvas, var(--background, #fff)),0 0 0 3px var(--ring, var(--primary, #1b4ed8))}`}
      </style>
      <header
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: border,
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        <span
          role="group"
          aria-label="Panel view"
          style={{ display: "flex", gap: 2, flexShrink: 0 }}
        >
          {(
            [
              ["pull-requests", "Pull requests"],
              ["repository", "Repository"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => switchView(value)}
              style={{
                ...control,
                padding: "2px 7px",
                fontSize: 12,
                fontWeight: view === value ? 600 : 400,
                background:
                  view === value
                    ? "var(--t3-version-control-accent-surface, var(--accent, #e8eef7))"
                    : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </span>
        {view === "repository" &&
          repo.kind === "ready" &&
          repo.capabilities.operations["status.refresh"] === true && (
            <button type="button" onClick={refresh} style={control}>
              Refresh
            </button>
          )}
        {view === "repository" && (
          <span style={{ color: muted, fontSize: 12 }}>
            {refreshError ?? describeStatus(status)}
          </span>
        )}
      </header>

      {view === "pull-requests" && (
        <PullRequestsPanel
          host={host}
          session={session}
          visible={visible}
          selected={selectedPr}
          onSelect={selectPr}
        />
      )}

      {view === "repository" && (
        <>
          {repo.kind === "loading" && (
            <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
              Reading repository capabilities…
            </p>
          )}
          {repo.kind === "unavailable" && (
            <p role="alert" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
              Repository status unavailable — {repo.detail}
            </p>
          )}
          {mutation.kind !== "idle" && mutation.receipt === "inline" && (
            <output
              aria-label="Mutation status"
              role={mutation.kind === "failed" ? "alert" : "status"}
              style={{
                display: "block",
                padding: "4px 10px",
                color:
                  mutation.kind === "failed"
                    ? "var(--t3-version-control-error, var(--destructive, #b42318))"
                    : muted,
                fontSize: 12,
              }}
            >
              {describeMutation(mutation)}
            </output>
          )}
          {repo.kind === "no-repository" && (
            <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
              This workspace is not a repository{repo.detail ? ` — ${repo.detail}` : ""}.
              {canInit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={runInit}
                  style={{ ...control, marginLeft: 6 }}
                >
                  Initialize Git repository
                </button>
              )}
              {!canInit && " Repository init is not supported by the detected drivers."}
            </p>
          )}
          {repo.kind === "unsupported" && (
            <p role="note" style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
              Unsupported repository driver: {repo.driverKind}. {repo.detail}
            </p>
          )}

          {repo.kind === "ready" && isRepo && (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 6 }}>
              {(canPull || canPush || publish.offered) && (
                <section
                  aria-label="Sync"
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px 6px" }}
                >
                  {canPull && (
                    <button
                      type="button"
                      disabled={busy || pull.disabled !== null}
                      onClick={runPull}
                      style={control}
                    >
                      {pull.label}
                    </button>
                  )}
                  {canPush && (
                    <button
                      type="button"
                      disabled={busy || push.disabled !== null}
                      onClick={runPush}
                      style={control}
                    >
                      {push.label}
                    </button>
                  )}
                  {publish.offered && (
                    <button
                      type="button"
                      disabled={busy || publish.disabled !== null || publishOpen}
                      onClick={() => setPublishOpen(true)}
                      style={control}
                    >
                      Publish repository…
                    </button>
                  )}
                  <span style={{ color: muted, fontSize: 11 }}>
                    {[
                      canPull ? pull.disabled : null,
                      canPush ? push.disabled : null,
                      publish.offered ? publish.disabled : null,
                    ]
                      .filter((reason) => reason !== null)
                      .join(" · ")}
                  </span>
                </section>
              )}
              {publish.offered && publishOpen && (
                <section
                  aria-label="Publish repository"
                  style={{
                    margin: "0 6px 8px",
                    padding: "4px 6px",
                    border: "1px solid var(--border, #dfe3e8)",
                    borderRadius: 5,
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <select
                      aria-label="Publish provider"
                      value={publishProvider}
                      disabled={busy}
                      onChange={(event) =>
                        setPublishProvider(event.target.value as PublishProviderKind)
                      }
                      style={{ ...control, padding: "2px 4px" }}
                    >
                      {PUBLISH_PROVIDERS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Repository path"
                      value={publishRepositoryPath}
                      disabled={busy}
                      onChange={(event) => setPublishRepositoryPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") runPublish();
                      }}
                      placeholder={publishProviderOption(publishProvider).pathPlaceholder}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        font: "inherit",
                        fontSize: 12,
                        padding: "3px 6px",
                        border,
                        borderRadius: 5,
                        background: "transparent",
                        color: "inherit",
                      }}
                    />
                    <select
                      aria-label="Repository visibility"
                      value={publishVisibility}
                      disabled={busy}
                      onChange={(event) =>
                        setPublishVisibility(event.target.value as "private" | "public")
                      }
                      style={{ ...control, padding: "2px 4px" }}
                    >
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <button
                      type="button"
                      aria-expanded={publishAdvancedOpen}
                      onClick={() => setPublishAdvancedOpen((open) => !open)}
                      style={{
                        ...control,
                        padding: "1px 0",
                        fontSize: 11,
                        border: "none",
                        color: muted,
                      }}
                    >
                      Advanced
                    </button>
                    {publishAdvancedOpen && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 2,
                          flexWrap: "wrap",
                        }}
                      >
                        <input
                          aria-label="Remote name"
                          value={publishRemoteName}
                          disabled={busy}
                          onChange={(event) => setPublishRemoteName(event.target.value)}
                          placeholder="origin"
                          style={{
                            width: 140,
                            font: "inherit",
                            fontSize: 12,
                            padding: "3px 6px",
                            border,
                            borderRadius: 5,
                            background: "transparent",
                            color: "inherit",
                          }}
                        />
                        <select
                          aria-label="Remote protocol"
                          value={publishProtocol}
                          disabled={busy}
                          onChange={(event) =>
                            setPublishProtocol(event.target.value as "ssh" | "https")
                          }
                          style={{ ...control, padding: "2px 4px" }}
                        >
                          <option value="ssh">SSH</option>
                          <option value="https">HTTPS</option>
                        </select>
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 4,
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      type="button"
                      disabled={busy || publishPlan.disabled !== null}
                      onClick={runPublish}
                      style={control}
                    >
                      Publish
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPublishOpen(false)}
                      style={control}
                    >
                      Cancel
                    </button>
                    {publishPlan.disabled !== null && publishRepositoryPath.trim() !== "" && (
                      <span style={{ color: muted, fontSize: 11 }}>{publishPlan.disabled}</span>
                    )}
                  </div>
                </section>
              )}
              {changes.error !== null && (
                <output
                  aria-label="Changes status"
                  style={{ display: "block", padding: "4px 6px", color: muted, fontSize: 12 }}
                >
                  {changes.error}
                </output>
              )}
              {changes.changes !== null && laneCount(lanes) === 0 && (
                <p style={{ padding: "4px 6px", color: muted, fontSize: 12, margin: 0 }}>
                  Working tree clean — nothing staged, modified, or untracked.
                </p>
              )}
              {CHANGE_LANES.map((lane) => {
                const bulk = laneMutation(lane);
                const rowAction = entryMutation(lane);
                const bulkAllowed = bulk !== null && (bulk.op === "stage" ? canStage : canUnstage);
                const rowAllowed =
                  rowAction !== null && (rowAction.op === "stage" ? canStage : canUnstage);
                return lanes[lane].length === 0 ? null : (
                  <section key={lane} aria-label={laneTitle(lane)} style={{ marginBottom: 8 }}>
                    <h3
                      style={{
                        margin: 0,
                        padding: "2px 6px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: muted,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span>
                        {laneTitle(lane)} ({lanes[lane].length})
                      </span>
                      {bulkAllowed && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            runPaths(
                              bulk.op,
                              lanes[lane].map((entry) => entry.path),
                              `${bulk.op === "stage" ? "Staging" : "Unstaging"} ${lanes[lane].length} paths`,
                            )
                          }
                          style={{ ...control, padding: "1px 6px", fontSize: 12 }}
                        >
                          {bulk.label}
                        </button>
                      )}
                    </h3>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {lanes[lane].map((entry) => (
                        <li
                          key={entry.path}
                          style={{ display: "flex", alignItems: "center", gap: 4 }}
                        >
                          <button
                            type="button"
                            aria-current={
                              selected?.path === entry.path && selected.lane === lane
                                ? "true"
                                : undefined
                            }
                            onClick={() => select(entry.path, lane)}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              textAlign: "left",
                              font: "inherit",
                              fontSize: 12,
                              padding: "4px 6px",
                              border: "1px solid transparent",
                              borderRadius: 5,
                              cursor: "pointer",
                              color: "var(--t3-version-control-text, var(--foreground, #20252d))",
                              background:
                                selected?.path === entry.path && selected.lane === lane
                                  ? "var(--t3-version-control-accent-surface, var(--accent, #e8eef7))"
                                  : "transparent",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {entry.path}
                            <span style={{ color: muted }}> — {describeEntry(entry)}</span>
                          </button>
                          {rowAllowed && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                runPaths(
                                  rowAction.op,
                                  [entry.path],
                                  `${rowAction.op === "stage" ? "Staging" : "Unstaging"} ${entry.path}`,
                                )
                              }
                              style={{
                                ...control,
                                padding: "1px 6px",
                                fontSize: 12,
                                flexShrink: 0,
                              }}
                            >
                              {rowAction.label}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}

              {(canCommit || canRunActions) && (
                <section aria-label="Commit" style={{ marginTop: 4, marginBottom: 8 }}>
                  <h3
                    style={{
                      margin: 0,
                      padding: "2px 6px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    Commit
                  </h3>
                  {status.local?.isDefaultRef === true && (
                    <p
                      style={{
                        margin: 0,
                        padding: "2px 6px",
                        fontSize: 12,
                        color: "var(--t3-version-control-warning, var(--warning, #b54708))",
                      }}
                    >
                      Warning: committing on the default branch
                    </p>
                  )}
                  <textarea
                    aria-label="Commit message"
                    value={commitMessage}
                    disabled={busy}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Commit message"
                    rows={2}
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      margin: "4px 0",
                      padding: "4px 6px",
                      font: "inherit",
                      fontSize: 14,
                      border,
                      borderRadius: 5,
                      background: "transparent",
                      color: "inherit",
                      resize: "vertical",
                    }}
                  />
                  {canCommit && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        disabled={busy || commit.disabled !== null}
                        onClick={runCommit}
                        style={control}
                      >
                        {commit.label}
                      </button>
                      {commit.disabled !== null && (
                        <span style={{ color: muted, fontSize: 12 }}>{commit.disabled}</span>
                      )}
                    </div>
                  )}
                  {canRunActions && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 4,
                        flexWrap: "wrap",
                      }}
                    >
                      <select
                        aria-label="Stacked action"
                        value={chosenOffer.action}
                        disabled={busy}
                        onChange={(event) => {
                          setStackedChoice(event.target.value as VcsActionKind);
                          setPendingConfirm(null);
                        }}
                        style={{ ...control, padding: "2px 4px" }}
                      >
                        {stackedOffers.map((offer) => (
                          <option
                            key={offer.action}
                            value={offer.action}
                            disabled={offer.disabled !== null}
                          >
                            {offer.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || chosenOffer.disabled !== null}
                        onClick={() =>
                          stackedActionNeedsConfirm(chosenOffer.action, status.local, featureBranch)
                            ? setPendingConfirm(chosenOffer.action)
                            : runStacked(chosenOffer)
                        }
                        style={control}
                      >
                        {busy && mutation.kind === "running" && mutation.op === "stacked"
                          ? `${chosenOffer.label}…`
                          : "Run"}
                      </button>
                      {status.local?.isDefaultRef === true &&
                        stackedActionCommits(chosenOffer.action) && (
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              fontSize: 12,
                              color: muted,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={featureBranch}
                              disabled={busy}
                              onChange={(event) => {
                                setFeatureBranch(event.target.checked);
                                setPendingConfirm(null);
                              }}
                            />
                            New feature branch
                          </label>
                        )}
                      {chooserReason !== null && (
                        <span style={{ color: muted, fontSize: 12 }}>{chooserReason}</span>
                      )}
                    </div>
                  )}
                  {pendingConfirm !== null &&
                    (() => {
                      const pending = stackedOffers.find(
                        (entry) => entry.action === pendingConfirm,
                      );
                      if (pending === undefined || pending.disabled !== null) return null;
                      const branchName = status.local?.refName ?? "the default ref";
                      // The feature-ref alternative exists only where a
                      // commit phase gives the new ref its delta — the
                      // service rejects featureBranch on push/PR-only runs.
                      const canFeatureBranch = stackedActionCommits(pending.action);
                      return (
                        <div
                          role="alertdialog"
                          aria-label="Confirm default-branch action"
                          style={{
                            margin: "4px 0",
                            padding: "4px 6px",
                            border: "1px solid var(--border, #dfe3e8)",
                            borderRadius: 5,
                            fontSize: 12,
                          }}
                        >
                          <div style={{ marginBottom: 4 }}>
                            {pending.label} on default ref &quot;{branchName}&quot;?
                            {canFeatureBranch
                              ? " You can continue on this ref or create a feature ref and run the same action there."
                              : " Continue on this ref or cancel."}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => runStacked(pending, { featureBranch: false })}
                              style={control}
                            >
                              {pending.label} on {branchName}
                            </button>
                            {canFeatureBranch && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setFeatureBranch(true);
                                  runStacked(pending, { featureBranch: true });
                                }}
                                style={control}
                              >
                                New feature branch
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setPendingConfirm(null)}
                              style={control}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  {stacked !== null && (
                    <div
                      aria-label="Action progress"
                      style={{
                        margin: "4px 0",
                        padding: "4px 6px",
                        border: "1px solid var(--border, #dfe3e8)",
                        borderRadius: 5,
                        fontSize: 12,
                      }}
                    >
                      <div>{describeStackedProgress(stacked.model)}</div>
                      {stacked.model.phases.length > 0 && (
                        <div style={{ color: muted }}>
                          {stacked.model.phases
                            .map((phase) => {
                              const startedAt = stacked.model.started.findIndex(
                                (entry) => entry.phase === phase,
                              );
                              const mark =
                                startedAt === -1
                                  ? "○"
                                  : stacked.model.result !== null ||
                                      stacked.model.failure !== null ||
                                      startedAt < stacked.model.started.length - 1
                                    ? "✓"
                                    : "…";
                              return `${mark} ${phase}`;
                            })
                            .join(" · ")}
                        </div>
                      )}
                      {stacked.model.failure !== null && (
                        <p
                          role="alert"
                          style={{ margin: "2px 0 0", color: "var(--destructive, #b42318)" }}
                        >
                          Failed
                          {stacked.model.failure.phase === null
                            ? ""
                            : ` during ${stacked.model.failure.phase}`}
                          : {stacked.model.failure.message}
                        </p>
                      )}
                      {stacked.model.result !== null && (
                        <p style={{ margin: "2px 0 0", color: muted }}>
                          {describeStackedResult(stacked.model.result)}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}

              <section aria-label="Refs" style={{ marginTop: 4 }}>
                <h3
                  style={{
                    margin: 0,
                    padding: "2px 6px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Refs{refs.refs ? ` (${refs.refs.totalCount})` : ""}
                </h3>
                {canCreateRef && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 6px 4px",
                    }}
                  >
                    <input
                      aria-label="New branch name"
                      value={newRefName}
                      disabled={busy}
                      onChange={(event) => setNewRefName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") runCreateRef();
                      }}
                      placeholder="New branch name"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        font: "inherit",
                        fontSize: 12,
                        padding: "3px 6px",
                        border,
                        borderRadius: 5,
                        background: "transparent",
                        color: "inherit",
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy || create.refName === null}
                      onClick={runCreateRef}
                      style={{ ...control, padding: "2px 6px", fontSize: 12, flexShrink: 0 }}
                    >
                      Create &amp; switch
                    </button>
                  </div>
                )}
                {canCreateRef && create.disabled !== null && newRefName.trim() !== "" && (
                  <output
                    aria-label="Branch create status"
                    style={{ display: "block", padding: "0 6px 4px", color: muted, fontSize: 12 }}
                  >
                    {create.disabled}
                  </output>
                )}
                {refs.error !== null && (
                  <output
                    aria-label="Refs status"
                    style={{ display: "block", padding: "4px 6px", color: muted, fontSize: 12 }}
                  >
                    {refs.error}
                  </output>
                )}
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {rows.map((row) => {
                    const switchState = refSwitchState(row, currentBranch);
                    return (
                      <li
                        key={`${row.remote ?? ""}:${row.name}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 6px",
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.name}
                          {describeRef(row) !== "" && (
                            <span style={{ color: muted }}> — {describeRef(row)}</span>
                          )}
                        </span>
                        {canSwitchRef && !row.current && !switchState.ok && (
                          <span style={{ color: muted, fontSize: 12, flexShrink: 0 }}>
                            {switchState.reason}
                          </span>
                        )}
                        {canSwitchRef && switchState.ok && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runSwitchRef(refSwitchTarget(row))}
                            style={{ ...control, padding: "1px 6px", fontSize: 12, flexShrink: 0 }}
                          >
                            Switch
                          </button>
                        )}
                        {canCreateWorktree && canWorktreeRef(row) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runCreateWorktree({ refName: row.name })}
                            style={{ ...control, padding: "1px 6px", fontSize: 12, flexShrink: 0 }}
                          >
                            Worktree
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {(canCreateWorktree || canRemoveWorktree) && (
                <section aria-label="Worktrees" style={{ marginTop: 4 }}>
                  <h3
                    style={{
                      margin: 0,
                      padding: "2px 6px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    Worktrees{worktrees.length > 0 ? ` (${worktrees.length})` : ""}
                  </h3>
                  {canCreateWorktree && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 6px 4px",
                      }}
                    >
                      <input
                        aria-label="New worktree branch"
                        value={newWorktreeName}
                        disabled={busy}
                        onChange={(event) => setNewWorktreeName(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            worktreePlan.branch !== null &&
                            worktreePlan.refName !== null
                          )
                            runCreateWorktree({
                              refName: worktreePlan.refName,
                              newRefName: worktreePlan.branch,
                              baseRefName: worktreePlan.baseRefName ?? undefined,
                            });
                        }}
                        placeholder="New worktree branch"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          font: "inherit",
                          fontSize: 12,
                          padding: "3px 6px",
                          border,
                          borderRadius: 5,
                          background: "transparent",
                          color: "inherit",
                        }}
                      />
                      <button
                        type="button"
                        disabled={busy || worktreePlan.branch === null}
                        onClick={() => {
                          if (worktreePlan.branch === null || worktreePlan.refName === null) return;
                          runCreateWorktree({
                            refName: worktreePlan.refName,
                            newRefName: worktreePlan.branch,
                            baseRefName: worktreePlan.baseRefName ?? undefined,
                          });
                        }}
                        style={{ ...control, padding: "2px 6px", fontSize: 12, flexShrink: 0 }}
                      >
                        Create worktree
                      </button>
                    </div>
                  )}
                  {canCreateWorktree &&
                    worktreePlan.disabled !== null &&
                    newWorktreeName.trim() !== "" && (
                      <output
                        aria-label="Worktree create status"
                        style={{
                          display: "block",
                          padding: "0 6px 4px",
                          color: muted,
                          fontSize: 12,
                        }}
                      >
                        {worktreePlan.disabled}
                      </output>
                    )}
                  {worktrees.length === 0 && (
                    <p style={{ margin: 0, padding: "2px 6px 4px", color: muted, fontSize: 12 }}>
                      No additional worktrees.
                    </p>
                  )}
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {worktrees.map((worktree) => (
                      <li
                        key={worktree.path}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 6px",
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {worktree.refName}
                          <span style={{ color: muted }}> — {worktree.path}</span>
                        </span>
                        {canRemoveWorktree && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runRemoveWorktree(worktree.path, false)}
                            style={{ ...control, padding: "1px 6px", fontSize: 12, flexShrink: 0 }}
                          >
                            Remove
                          </button>
                        )}
                        {canRemoveWorktree && worktreeRemoveFailures.has(worktree.path) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runRemoveWorktree(worktree.path, true)}
                            style={{
                              ...control,
                              padding: "1px 6px",
                              fontSize: 12,
                              flexShrink: 0,
                              color: "var(--t3-version-control-error, var(--destructive, #b42318))",
                            }}
                          >
                            Force remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {canListRemotes && (
                <section aria-label="Remotes" style={{ marginTop: 4 }}>
                  <h3
                    style={{
                      margin: 0,
                      padding: "2px 6px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>Remotes{remoteList.length > 0 ? ` (${remoteList.length})` : ""}</span>
                    {canFetch && remoteList.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => runFetch()}
                        style={{ ...control, padding: "1px 6px", fontSize: 12 }}
                      >
                        Fetch all
                      </button>
                    )}
                  </h3>
                  {remotes.error !== null && (
                    <output
                      aria-label="Remotes status"
                      style={{ display: "block", padding: "4px 6px", color: muted, fontSize: 12 }}
                    >
                      {remotes.error}
                    </output>
                  )}
                  {remotes.remotes !== null && remoteList.length === 0 && (
                    <p style={{ margin: 0, padding: "2px 6px 4px", color: muted, fontSize: 12 }}>
                      No remotes configured.
                    </p>
                  )}
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {remoteList.map((remote) => (
                      <li
                        key={remote.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 6px",
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {remote.name}
                          <span style={{ color: muted }}>
                            {" "}
                            — {remote.url}
                            {remote.isPrimary ? " · primary" : ""}
                          </span>
                        </span>
                        {canFetch && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => runFetch(remote.name)}
                            style={{ ...control, padding: "1px 6px", fontSize: 12, flexShrink: 0 }}
                          >
                            Fetch
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {selected !== null && selectedEntry !== null && (
            <output
              aria-label="Selection"
              style={{
                padding: "6px 10px",
                color: muted,
                fontSize: 12,
                borderTop: border,
                flexShrink: 0,
              }}
            >
              {selected.path} — {describeEntry(selectedEntry)}
              {selectedStat !== null
                ? ` (+${selectedStat.insertions} −${selectedStat.deletions})`
                : ""}
            </output>
          )}
        </>
      )}

      <output
        aria-label="Slice notice"
        style={{
          padding: "6px 10px",
          color: muted,
          fontSize: 12,
          borderTop: border,
          flexShrink: 0,
        }}
      >
        Version Control on t3.vcs + t3.prs: pull-request browse/detail/diff plus host writes
        (actions, comments, reviews, thread reply/resolve — t3.prs/write), status, staging lanes,
        stage/unstage/commit, branch create/switch, pull/push/fetch, init, worktrees, and remotes
        (t3.vcs/mutate); composite commit+push+PR actions and publish repository (t3.vcs/actions).
        Clone/discovery, stash, and per-hunk diff expansion are deferred slices.
      </output>
    </section>
  );
}

export default defineExtension({
  id: manifestId,
  version: "0.4.0",
  requires: [
    requireApi(prsReadApi),
    requireApi(prsWriteApi),
    requireApi(vcsActionsApi),
    requireApi(vcsStatusApi),
    requireApi(vcsChangesApi),
    requireApi(vcsRefsApi),
    requireApi(vcsRepositoryApi, REPOSITORY_API_RANGE),
    requireApi(uiThemeApi),
    requireApi(uiNotificationsApi),
  ],
  surfaces: [
    {
      name: "view",
      title: "Version Control",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 2,
      validateRestore: restoreState,
      createView(host, session) {
        return { renderer: () => <VersionControlView host={host} session={session} /> };
      },
    },
  ],
});
