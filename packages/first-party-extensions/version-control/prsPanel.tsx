/**
 * The pull-request browser — the Version Control panel's primary
 * surface (the native surface is a PR browser). Everything here reads through the
 * public `t3.prs/read` contract: the capability gate names unavailable
 * states, the list sends state/involvement/search to the host, detail
 * sections load independently so one failing read cannot blank the
 * rest, and `streamDiff` frames verify before a single byte renders.
 *
 * Writes ride `t3.prs/write`: the write probe decides which affordances
 * exist — actions bar, comment composer, review submit, thread reply and
 * resolve — and a grant the installation does not hold reads back as a
 * named unavailability, never a dead button.
 */
import {
  prsReadApi,
  prsWriteApi,
  uiExternalApi,
  vcsActionsApi,
  vcsRefsApi,
  type PrsActivity,
  type PrsCapabilitiesResult,
  type PrsCheck,
  type PrsComment,
  type PrsDetail,
  type PrsLinkedThreadsResult,
  type PrsListEntry,
  type PrsListResult,
  type PrsOperationsSupport,
  type PrsRef,
  type PrsReviewThread,
  type PrsStack,
  type PrsThreadComment,
  type PrsWriteCapabilitiesResult,
  type PrsWriteOperationsSupport,
  type PrsWriteMergeMethod,
  type PrsWriteUpdateMethod,
  type PrsWriteVerdict,
  type VcsPullRequestHandoffTask,
  type VcsRefEntry,
} from "@t3tools/extension-sdk/catalogue";
import { copyText, Tooltip } from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import {
  resolveFloatingDialog,
  resolveFloatingLayer,
  resolvePullRequestPreferences,
  type ClientHost,
} from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useMutationToasts, type MutationToastPatch } from "./mutationToasts.js";
import { PrsMetadataPicker } from "./prsMetadataPickers.js";
import { border, muted } from "./prsPresentation.js";
import { usePrsFilesViewed } from "./usePrsFilesViewed.js";
import {
  PRS_INVOLVEMENTS,
  PRS_LIST_STATES,
  collectPrsDiffStream,
  displayPath,
  changeTypeLabel,
  fileRows,
  fileStatLabel,
  formatRelativeTime,
  mergePrsDiffSegment,
  mergePrsEntries,
  prsActorLabel,
  prsAllowedMergeMethods,
  prsAuthoredByViewer,
  prsCanMergeStack,
  prsResolveMergeMethod,
  prsCanRebaseStack,
  prsStackRebasePlan,
  prsStackRebaseReceipt,
  prsStackMergePlan,
  prsStackMergeReceipt,
  prsBranchUrl,
  prsCheckoutLabel,
  prsCheckoutOptions,
  prsCheckoutReceipt,
  prsResolveConflictsControl,
  prsCommitUrl,
  prsHeadRepositoryUrl,
  prsOpenOnHostLabel,
  prsOpenRefusedLabel,
  prsRepositoryUrl,
  prsBranchChips,
  prsStackedOnDefault,
  prsChecksIcon,
  prsReconcileChecks,
  prsChecksSummary,
  prsCheckStatusLabel,
  prsDraftKey,
  prsGate,
  prsListHasMore,
  prsListInput,
  prsMergeabilityLabel,
  prsOmittedFilesLabel,
  prsProviderLabel,
  prsRefKey,
  prsRefreshClosedLabel,
  prsReviewLabel,
  prsReviewVerdict,
  prsReviewVerdictLabel,
  prsRowMeta,
  prsStackLabel,
  prsThreadAnchor,
  prsThreadMoreLabel,
  prsThreadStateLabel,
  prsUnavailableLabel,
  prsActionPresentation,
  prsActorTooltip,
  prsArmedAutoMergeTooltip,
  prsCheckTooltip,
  prsConflictTooltip,
  prsReviewTooltip,
  prsStackTooltip,
  prsWriteActionOffers,
  prsSingleMergeAllowed,
  prsWriteGate,
  prsWriteUnavailableNote,
  prsWriteVerdictOptions,
  renderableFromPatch,
  settlePrsDraft,
  type DiffFileRow,
  type PrsDiffDelivery,
  type PrsInvolvement,
  type PrsCheckoutMode,
  type PrsListState,
  type PrsReceipt,
  type PrsWriteActionOffer,
} from "./prsViewModel.js";

// Theme-backed values chain a `--t3-version-control-*` hop (published on the
// view root from `t3.ui/theme` tokens) ahead of the legacy host vars; an
// unserved hop never resolves and the legacy chain renders.
const hairline = "1px solid var(--t3-version-control-border, var(--border, #f0f2f5))";

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

const iconButton = { ...control, padding: "2px 6px", fontSize: 12 } as const;

const inputStyle = {
  flex: 1,
  minWidth: 0,
  font: "inherit",
  fontSize: 14,
  padding: "3px 6px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
} as const;

/** An inline link that opens on the host: text-coloured until hovered, like native's. */
const linkButton = {
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
} as const;

const oidStyle = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  color: muted,
  fontSize: 11,
} as const;

const noteStyle = {
  margin: 0,
  padding: "4px 10px",
  color: muted,
  fontSize: 12,
} as const;

const headingStyle = {
  margin: 0,
  padding: "2px 10px",
  fontSize: 12,
  fontWeight: 600,
  color: muted,
  textTransform: "uppercase",
  letterSpacing: 0.4,
} as const;

/**
 * A paged tail can repeat a comment the head already carried (host-side
 * edits, retried pages) — merge by id so a duplicate never double-renders
 * or collides on a React key.
 */
const mergeThreadComments = (
  head: readonly PrsThreadComment[],
  tail: readonly PrsThreadComment[],
) => {
  const seen = new Set(head.map((comment) => comment.id));
  const merged = [...head];
  for (const comment of tail)
    if (!seen.has(comment.id)) {
      seen.add(comment.id);
      merged.push(comment);
    }
  return merged;
};

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/* ---------------- data hooks ---------------- */

/** One-shot `prs.getCapabilities`; the named gate decides what the panel may show. */
function usePrsCapabilities(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  tick: number,
) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: PrsCapabilitiesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(prsReadApi, host, session.context)
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
              error: message(error, "Pull-request capabilities unavailable"),
            });
        },
      );
    return () => controller.abort();
  }, [host, session, visible, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * One-shot `prsWrite.getCapabilities` — the write side's own probe. A
 * denied grant fails the invoke, which the write gate names verbatim;
 * nothing here assumes the installation holds `t3.prs/write`.
 */
function usePrsWriteCapabilities(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  tick: number,
) {
  const [result, setResult] = useState<{
    key: number;
    capabilities: PrsWriteCapabilitiesResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(prsWriteApi, host, session.context)
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
              error: message(error, "Pull-request write capabilities unavailable"),
            });
        },
      );
    return () => controller.abort();
  }, [host, session, enabled, tick]);
  return result?.key === tick ? result : { capabilities: null, error: null };
}

/**
 * Whether this workspace can prepare a pull-request checkout
 * (`t3.vcs/actions` `preparePullRequestThread`), and whether the host can run
 * it as a handoff that opens a thread (`handoffPullRequest`, 1.1.0). A failed
 * probe — no git, a denied grant — simply leaves the offer out.
 */
function useCheckoutSupport(host: ClientHost, session: ViewSession, enabled: boolean) {
  const [supported, setSupported] = useState({ checkout: false, handoff: false });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(vcsActionsApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          if (!signal.aborted)
            setSupported({
              checkout:
                capabilities.detected &&
                capabilities.operations["actions.preparePullRequestThread"] === true,
              handoff:
                capabilities.detected &&
                capabilities.operations["actions.handoffPullRequest"] === true,
            });
        },
        () => {
          if (!signal.aborted) setSupported({ checkout: false, handoff: false });
        },
      );
    return () => controller.abort();
  }, [host, session, enabled]);
  return enabled ? supported : { checkout: false, handoff: false };
}

/**
 * The workspace's current and default refs (`t3.vcs/refs`), which native
 * reads to tell a stacked base from the default branch. A failed read shows
 * no badge rather than a guess.
 */
function useDefaultRefs(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  revision: string,
) {
  const [refs, setRefs] = useState<readonly VcsRefEntry[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    // listRefs keeps the current ref first and a known default second.
    void bindApi(vcsRefsApi, host, session.context)
      .invoke("list", { includeMatchingRemoteRefs: true, limit: 2 }, signal)
      .then(
        (result) => {
          if (!signal.aborted) setRefs(result.refs);
        },
        () => {
          if (!signal.aborted) setRefs(null);
        },
      );
    return () => controller.abort();
  }, [host, session, enabled, revision]);
  return enabled ? refs : null;
}

/**
 * Host-driven freshness via `prs.subscribeRefreshes` — the panel never
 * polls. Each `refreshed` frame bumps the tick that re-reads list and
 * detail; `closed` frames resubscribe with the same bounded retry the
 * status stream uses, and an ended stream is named, not silent.
 */
function usePrsRefreshes(host: ClientHost, session: ViewSession, enabled: boolean) {
  const [state, setState] = useState<{ tick: number; live: boolean; detail: string | null }>({
    tick: 0,
    live: false,
    detail: null,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
        let closed: string | null = null;
        try {
          const stream = bindStreamApi(prsReadApi, host, session.context).subscribe(
            "subscribeRefreshes",
            {},
            signal,
          );
          for await (const frame of stream) {
            if (signal.aborted) return;
            const event = frame.value;
            if (event.kind === "refreshed") {
              setState((prev) => ({ tick: prev.tick + 1, live: true, detail: null }));
            } else {
              closed = prsRefreshClosedLabel(event.reason);
              break;
            }
          }
        } catch (error) {
          if (!signal.aborted)
            setState((prev) => ({
              ...prev,
              live: false,
              detail: message(error, "Refresh stream unavailable"),
            }));
          return;
        }
        if (signal.aborted) return;
        if (closed === null) {
          setState((prev) => ({
            ...prev,
            live: false,
            detail: "Refresh stream ended unexpectedly.",
          }));
          return;
        }
        setState((prev) => ({ ...prev, live: false, detail: closed }));
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      if (!signal.aborted)
        setState((prev) => ({
          ...prev,
          live: false,
          detail: "Refresh stream ended repeatedly.",
        }));
    })();
    return () => controller.abort();
  }, [host, session, enabled]);
  return state;
}

interface PrsListModel {
  readonly key: string;
  /** Query identity without the refresh tick — same question, newer ask. */
  readonly inputKey: string;
  readonly entries: readonly PrsListEntry[];
  /** Client arrival time of the successful read each row came from, by `prsRefKey`. */
  readonly receivedAt: Readonly<Record<string, number>>;
  readonly result: PrsListResult | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly loadingMore: boolean;
}

function stampEntries(
  entries: readonly PrsListEntry[],
  receivedAt: number,
): Readonly<Record<string, number>> {
  return Object.fromEntries(entries.map((entry) => [prsRefKey(entry), receivedAt]));
}

/**
 * `prs.list` with re-read + continuation: the key folds the input and
 * the refresh tick; each fresh read replaces entries in place, and
 * "load more" appends the next host-cursored page. Rows are displayed
 * only for the query that produced them — a filter change never shows
 * another question's rows, and a revision bump keeps the last answer
 * until the fresh page lands. A failed re-read keeps the last page of
 * the same query — same rule the staging lanes follow. In-flight
 * continuations are aborted on any key change and merge only into the
 * generation that requested them, so a late page can't contaminate a
 * newer query.
 */
function usePrsList(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  input: ReturnType<typeof prsListInput>,
  revision: string,
) {
  const inputKey = useMemo(() => JSON.stringify(input), [input]);
  const key = `${revision}|${inputKey}`;
  const [state, setState] = useState<PrsListModel | null>(null);
  const continuation = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(prsReadApi, host, session.context)
      .invoke("list", input, signal)
      .then(
        (result) => {
          if (!signal.aborted)
            setState(() => ({
              key,
              inputKey,
              // A re-read answers the same question — a row that left the
              // fresh page (a closed PR under the open filter, a renamed
              // search hit) must leave the list rather than linger stale.
              // Continuation pages merge on their own path in loadMore.
              entries: result.entries,
              receivedAt: stampEntries(result.entries, Date.now()),
              result,
              error: null,
              pending: false,
              loadingMore: false,
            }));
        },
        (error) => {
          if (!signal.aborted)
            setState((prev) => ({
              key,
              inputKey,
              entries: prev?.inputKey === inputKey ? prev.entries : [],
              // A failed re-read keeps rows only as old as the read they came from.
              receivedAt: prev?.inputKey === inputKey ? prev.receivedAt : {},
              result: prev?.inputKey === inputKey ? prev.result : null,
              error: message(error, "Pull requests unavailable"),
              pending: false,
              loadingMore: false,
            }));
        },
      );
    return () => {
      controller.abort();
      // A continuation still in flight belongs to this generation.
      continuation.current?.abort();
      continuation.current = null;
    };
    // input identity is folded into key.
  }, [host, session, enabled, key, inputKey, input]);

  const loadMore = () => {
    if (
      state === null ||
      state.key !== key ||
      state.result === null ||
      !prsListHasMore(state.result)
    )
      return;
    const cursors = state.result.nextCursors;
    setState((prev) => (prev === null || prev.key !== key ? prev : { ...prev, loadingMore: true }));
    continuation.current?.abort();
    const controller = new AbortController();
    continuation.current = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(prsReadApi, host, session.context)
      .invoke("list", { ...input, cursors }, signal)
      .then(
        (page) => {
          if (!signal.aborted)
            setState((prev) =>
              prev === null || prev.key !== key
                ? prev
                : {
                    ...prev,
                    entries: mergePrsEntries(prev.entries, page.entries),
                    receivedAt: { ...prev.receivedAt, ...stampEntries(page.entries, Date.now()) },
                    result: page,
                    loadingMore: false,
                  },
            );
        },
        (error) => {
          if (!signal.aborted)
            setState((prev) =>
              prev === null || prev.key !== key
                ? prev
                : { ...prev, error: message(error, "Next page unavailable"), loadingMore: false },
            );
        },
      )
      .finally(() => {
        if (continuation.current === controller) continuation.current = null;
        controller.abort();
      });
  };

  const sameQuestion = state !== null && state.inputKey === inputKey;
  return {
    entries: sameQuestion ? state.entries : [],
    receivedAt: sameQuestion ? state.receivedAt : {},
    result: sameQuestion ? state.result : null,
    error: state?.key === key ? state.error : null,
    pending: state?.key !== key || state.pending,
    loadingMore: state?.key === key ? state.loadingMore : false,
    loadMore,
  };
}

interface PrsDetailSections {
  key: string;
  /** PR identity — retention and display never cross this boundary. */
  refKey: string;
  detail: PrsDetail | null;
  /** Client arrival time of the detail read that answered `detail`. */
  detailReceivedAt: number;
  detailError: string | null;
  activity: PrsActivity | null;
  activityError: string | null;
  linked: PrsLinkedThreadsResult | null;
  linkedError: string | null;
  stack: PrsStack | null;
  stackError: string | null;
  /**
   * The detail key the stack was last read for. The stack section keeps its
   * last answer across a refresh, so this — not the shared `key`, which any
   * sibling read advances — is what says the stack is fresh.
   */
  stackKey: string | null;
}

const EMPTY_SECTIONS: Omit<PrsDetailSections, "key" | "refKey"> = {
  detail: null,
  detailReceivedAt: 0,
  detailError: null,
  activity: null,
  activityError: null,
  linked: null,
  linkedError: null,
  stack: null,
  stackError: null,
  stackKey: null,
};

/**
 * The detail bundle: `detail`, `activity`, `linkedThreads`, and `stack`
 * read in parallel and settle independently — a denied or failing
 * section reports its own error instead of blanking the panel.
 */
function usePrsDetail(
  host: ClientHost,
  session: ViewSession,
  ref: PrsRef | null,
  operations: PrsOperationsSupport | null,
  revision: string,
) {
  const refKey = ref === null ? null : prsRefKey(ref);
  const key = refKey === null ? null : `${revision}|${refKey}`;
  const [sections, setSections] = useState<PrsDetailSections | null>(null);
  useEffect(() => {
    if (ref === null || refKey === null || key === null || operations === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(prsReadApi, host, session.context);
    // Each section publishes as its own read settles — a slow or failing
    // read never withholds a sibling that already resolved. Retained
    // fields require the same PR (refKey): a failed re-read keeps
    // last-good data alongside its disclosed error, and nothing ever
    // crosses a selection boundary.
    const read = <T,>(
      field: "detail" | "activity" | "linked" | "stack",
      errorField: "detailError" | "activityError" | "linkedError" | "stackError",
      supported: boolean,
      run: () => Promise<T>,
    ) => {
      if (!supported) return;
      void run().then(
        (value) => {
          if (!signal.aborted)
            setSections((prev) => ({
              ...(prev?.refKey === refKey ? prev : { ...EMPTY_SECTIONS }),
              key,
              refKey,
              [field]: value,
              [errorField]: null,
              ...(field === "stack" ? { stackKey: key } : {}),
              ...(field === "detail" ? { detailReceivedAt: Date.now() } : {}),
            }));
        },
        (error: unknown) => {
          if (!signal.aborted)
            setSections((prev) => ({
              ...(prev?.refKey === refKey ? prev : { ...EMPTY_SECTIONS }),
              key,
              refKey,
              [errorField]: message(error, `${field} unavailable`),
            }));
        },
      );
    };
    read("detail", "detailError", operations["prs.detail"], () =>
      api.invoke("detail", ref, signal),
    );
    read("activity", "activityError", operations["prs.activity"], () =>
      api.invoke("activity", ref, signal),
    );
    read("linked", "linkedError", operations["prs.linkedThreads"], () =>
      api.invoke("linkedThreads", ref, signal),
    );
    read("stack", "stackError", operations["prs.stack"], () => api.invoke("stack", ref, signal));
    return () => controller.abort();
    // ref identity is folded into key.
  }, [host, session, ref, refKey, operations, key]);
  const current =
    sections?.refKey === refKey && refKey !== null
      ? sections
      : { key: key ?? "", refKey: refKey ?? "", ...EMPTY_SECTIONS };
  // Only a stack read that answered this very key is fresh: a retained stack
  // may be one refresh old while its re-read is still in flight.
  return { ...current, stackFresh: key !== null && current.stackKey === key };
}

type PrsDiffState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly detail: string }
  | { readonly status: "ready"; readonly delivery: PrsDiffDelivery; readonly loadingMore: boolean };

/** A stream failure as a named line — the same wording family the diff panel reports. */
function prsDiffFailure(detail: { readonly kind: string; readonly detail?: string }): string {
  switch (detail.kind) {
    case "protocol":
      return `Diff stream protocol error: ${detail.detail ?? "unknown"}`;
    case "incomplete":
      return `Diff stream ended before completing — ${detail.detail ?? "unknown"}. Refresh to retry.`;
    case "mismatch":
      return `Diff verification failed: ${detail.detail ?? "unknown"}. Nothing is shown.`;
    default:
      return "Diff stream unavailable";
  }
}

/**
 * `prs.streamDiff` → fold → sha256 verify → deliver. A truncated
 * manifest keeps `nextCursor`; "load more" resumes with that cursor as
 * a fresh, independently verified stream whose patch text appends.
 */
function usePrsDiff(
  host: ClientHost,
  session: ViewSession,
  ref: PrsRef | null,
  enabled: boolean,
  revision: string,
) {
  const refKey = ref === null ? null : prsRefKey(ref);
  const key = refKey === null ? null : `${revision}|${refKey}`;
  const [state, setState] = useState<{ key: string; value: PrsDiffState } | null>(null);
  useEffect(() => {
    if (!enabled || ref === null || key === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void collectPrsDiffStream(
      bindStreamApi(prsReadApi, host, session.context).subscribe("streamDiff", ref, signal),
      signal,
    ).then(
      (outcome) => {
        if (signal.aborted || outcome.kind === "cancelled") return;
        setState(
          outcome.kind === "verified"
            ? {
                key,
                value: {
                  status: "ready",
                  delivery: mergePrsDiffSegment(null, outcome.manifest, outcome.patch),
                  loadingMore: false,
                },
              }
            : { key, value: { status: "error", detail: prsDiffFailure(outcome) } },
        );
      },
      (error) => {
        if (!signal.aborted)
          setState({
            key,
            value: { status: "error", detail: message(error, "Diff stream unavailable") },
          });
      },
    );
    return () => controller.abort();
    // ref identity is folded into key.
  }, [host, session, ref, enabled, key]);

  const loadMore = () => {
    if (ref === null || state === null || state.key !== key || state.value.status !== "ready")
      return;
    const cursor = state.value.delivery.nextCursor;
    if (cursor === null) return;
    setState({ key: state.key, value: { ...state.value, loadingMore: true } });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void collectPrsDiffStream(
      bindStreamApi(prsReadApi, host, session.context).subscribe(
        "streamDiff",
        { ...ref, cursor },
        signal,
      ),
      signal,
    )
      .then(
        (outcome) => {
          if (signal.aborted || outcome.kind === "cancelled") return;
          setState((prev) => {
            if (prev === null || prev.key !== key || prev.value.status !== "ready") return prev;
            // A failed continuation keeps the verified segments — the
            // panel reports the failure and still shows what verified.
            if (outcome.kind !== "verified")
              return {
                key: prev.key,
                value: { status: "error", detail: prsDiffFailure(outcome) },
              };
            return {
              key: prev.key,
              value: {
                status: "ready",
                delivery: mergePrsDiffSegment(prev.value.delivery, outcome.manifest, outcome.patch),
                loadingMore: false,
              },
            };
          });
        },
        (error) => {
          if (!signal.aborted)
            setState((prev) =>
              prev === null || prev.key !== key
                ? prev
                : {
                    key: prev.key,
                    value: { status: "error", detail: message(error, "Diff stream unavailable") },
                  },
            );
        },
      )
      .finally(() => controller.abort());
  };

  const value = state?.key === key ? state.value : { status: "loading" as const };
  return { diff: value, loadMore };
}

/** Debounce the search text so each keystroke is not a host query. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/* ---------------- list ---------------- */

function badge(text: string, tone: "open" | "closed" | "merged" | "muted") {
  const colors: Record<string, string> = {
    // `--success`/`--info` are host constants outside the theme contract's
    // role set — the native panel reads the same variables.
    open: "var(--success, #2da44e)",
    closed: muted,
    merged: "var(--info, #8250df)",
    muted,
  };
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        padding: "0 5px",
        borderRadius: 8,
        border: `1px solid ${colors[tone]}`,
        color: colors[tone],
      }}
    >
      {text}
    </span>
  );
}

function stateBadge(
  host: ClientHost,
  entry: { readonly state: string; readonly isDraft?: boolean },
) {
  const [text, tone] =
    entry.state === "open" && entry.isDraft
      ? (["Draft", "muted"] as const)
      : entry.state === "open"
        ? (["Open", "open"] as const)
        : entry.state === "merged"
          ? (["Merged", "merged"] as const)
          : (["Closed", "closed"] as const);
  return (
    <Tooltip host={host} side="top" label={text}>
      {badge(text, tone)}
    </Tooltip>
  );
}

const CHECKS_TONES = {
  success: "var(--success, #2da44e)",
  destructive: "var(--t3-version-control-error, var(--destructive, #b42318))",
  warning: "var(--warning, #b54708)",
} as const;

type LazyChecks =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly checks: readonly PrsCheck[] }
  | { readonly status: "error"; readonly detail: string };

const FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex]';

/**
 * The controls Tab visits inside `root`, in document order: focusable ones
 * whose tabIndex keeps them in the Tab order, and that no disabled state,
 * `hidden` or `inert` ancestor, or computed `display: none` or
 * `visibility: hidden`, takes out of it.
 */
function tabbablesIn(root: Element | Document): HTMLElement[] {
  if (typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.closest("[hidden],[inert]") === null &&
      isRendered(element),
  );
}

function isRendered(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return true;
  if (view.getComputedStyle(element).visibility !== "visible") return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (view.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/**
 * Where Tab goes after `from` once the popover it opened closes: the popover
 * is portaled to the end of the page, so the next control is the one after
 * its trigger, not after the popover.
 */
function tabbableAfter(from: HTMLElement, popup: HTMLElement | null): HTMLElement | null {
  const order = tabbablesIn(from.ownerDocument).filter(
    (element) => popup === null || !popup.contains(element),
  );
  return order[order.indexOf(from) + 1] ?? null;
}

/**
 * Native's checks indicator and the popover it opens, on a list row and in
 * the detail header. The header passes the checks it holds; a row passes
 * `loadChecks`, read only once the popover opens. The trigger is a
 * focusable span, not a button — a row is itself a button — and it stops
 * its click and Enter/Space so opening the checks never selects the row.
 * Focus moves as native's popover moves it: into the popover once it is
 * placed, Tab through its links and on past its trigger, Shift-Tab back to
 * the trigger, and focus leaving it closes it.
 */
export function ChecksControl(props: {
  host: ClientHost;
  state: "passing" | "failing" | "pending" | null | undefined;
  checks?: readonly PrsCheck[];
  stale?: boolean;
  loadChecks?: (signal: AbortSignal) => Promise<readonly PrsCheck[]>;
  onOpenLink: (url: string) => void;
}) {
  const { host, state, checks, stale = false, loadChecks, onOpenLink } = props;
  const icon = prsChecksIcon(state);
  const [open, setOpen] = useState(false);
  const [lazy, setLazy] = useState<LazyChecks>({ status: "loading" });
  const trigger = useRef<HTMLSpanElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const [popupElement, setPopupElement] = useState<HTMLDivElement | null>(null);
  const attachPopup = useCallback((element: HTMLDivElement | null) => {
    popup.current = element;
    setPopupElement(element);
  }, []);
  useEffect(() => {
    if (!open || popupElement === null) return;
    // After the host has placed it: an unplaced popover is hidden and cannot take focus.
    const timer = setTimeout(() => {
      (tabbablesIn(popupElement)[0] ?? popupElement).focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, popupElement]);
  useEffect(() => {
    if (!open || checks !== undefined || loadChecks === undefined) return;
    const controller = new AbortController();
    setLazy({ status: "loading" });
    loadChecks(controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setLazy({ status: "ready", checks: loaded });
      },
      (error) => {
        if (!controller.signal.aborted)
          setLazy({ status: "error", detail: message(error, "Checks unavailable") });
      },
    );
    return () => controller.abort();
    // loadChecks is rebuilt every render; the read belongs to the opening.
  }, [open]);
  useEffect(() => {
    if (!open || typeof document === "undefined" || !("addEventListener" in document)) return;
    const onPress = (event: Event) => {
      const target = event.target as Node | null;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [open]);
  if (icon === null) return null;
  const close = (focus: HTMLElement | null = trigger.current) => {
    setOpen(false);
    focus?.focus();
  };
  const shown: LazyChecks | null =
    checks !== undefined ? { status: "ready", checks } : loadChecks !== undefined ? lazy : null;
  const summary = checks === undefined || stale ? null : prsChecksSummary(checks);
  const Popover = resolveFloatingLayer(host)?.Popover;
  const popupProps = {
    role: "dialog",
    "aria-label": "Checks",
    // Portaled or not, React delivers these through the row: keep them here.
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onKeyDown: (event: {
      key: string;
      shiftKey: boolean;
      stopPropagation: () => void;
      preventDefault: () => void;
    }) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || popup.current === null) return;
      event.preventDefault();
      const items = tabbablesIn(popup.current);
      const at = items.findIndex((item) => item === popup.current?.ownerDocument.activeElement);
      const next = event.shiftKey ? (at === -1 ? -1 : at - 1) : at + 1;
      if (next >= 0 && next < items.length) items[next]?.focus();
      else if (event.shiftKey || trigger.current === null) close();
      else close(tabbableAfter(trigger.current, popup.current) ?? trigger.current);
    },
    onBlur: (event: { relatedTarget: EventTarget | null }) => {
      const inside = (node: unknown) =>
        node != null &&
        (popup.current?.contains(node as Node) === true ||
          trigger.current?.contains(node as Node) === true);
      if (event.relatedTarget !== null) {
        if (!inside(event.relatedTarget)) setOpen(false);
        return;
      }
      // No target: focus fell to the page, or the window lost it and will bring it back here.
      setTimeout(() => {
        if (!inside(popup.current?.ownerDocument.activeElement)) setOpen(false);
      }, 0);
    },
    tabIndex: -1,
    style: {
      width: 320,
      maxWidth: "calc(100vw - 24px)",
      padding: "8px 10px",
      border,
      borderRadius: 6,
      fontSize: 12,
      textAlign: "left",
      cursor: "default",
      color: "var(--t3-version-control-text, var(--foreground, #20252d))",
      background: "var(--t3-version-control-background, var(--popover, var(--background, #fff)))",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
    },
  } as const;
  const body = (
    <>
      <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 13 }}>{icon.label}</p>
      {summary !== null && <p style={{ margin: "0 0 6px", color: muted }}>{summary}</p>}
      {stale ? (
        <p style={{ margin: 0, color: muted }}>
          Check details are out of date. Refresh the pull request to update them.
        </p>
      ) : shown?.status === "loading" ? (
        <p style={{ margin: 0, color: muted }}>Loading checks…</p>
      ) : shown?.status === "error" ? (
        <p style={{ margin: 0, color: muted }}>{shown.detail}</p>
      ) : shown?.status === "ready" && shown.checks.length === 0 ? (
        <p style={{ margin: 0, color: muted }}>No checks reported</p>
      ) : shown?.status === "ready" ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.checks.map((check, index) => (
            <li
              key={`${index}:${check.name}`}
              style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "1px 0" }}
            >
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{check.name}</span>
              <span style={{ flexShrink: 0, color: muted }}>
                {prsCheckStatusLabel(check.status)}
              </span>
              {check.url !== null && (
                <button
                  type="button"
                  aria-label={`Open check ${check.name}`}
                  onClick={() => check.url !== null && onOpenLink(check.url)}
                  style={{ ...linkButton, flexShrink: 0 }}
                >
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <span
        ref={trigger}
        role="button"
        tabIndex={0}
        aria-label={`Checks: ${icon.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            setOpen((value) => !value);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        style={{
          fontSize: 11,
          lineHeight: 1,
          cursor: "pointer",
          color: CHECKS_TONES[icon.tone],
        }}
      >
        {icon.glyph}
      </span>
      {open &&
        (Popover !== undefined && trigger.current !== null ? (
          <Popover
            {...popupProps}
            anchor={trigger.current}
            side="bottom"
            align="start"
            elementRef={attachPopup}
          >
            {body}
          </Popover>
        ) : (
          <div
            {...popupProps}
            ref={attachPopup}
            style={{ ...popupProps.style, position: "absolute", top: "100%", left: 0, zIndex: 10 }}
          >
            {body}
          </div>
        ))}
    </span>
  );
}

const chipStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 11,
} as const;

/**
 * Native's `PullRequestCopyableCode`: the chip copies its value, says so for
 * 1.6 s, and its tooltip names the action. A failed copy is reported.
 */
function CopyableCode(props: {
  host: ClientHost;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  onError: (detail: string) => void;
}) {
  const { host, value, copyLabel, copiedLabel, onError } = props;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    copyText(value).then(
      () => setCopied(true),
      (error: unknown) => onError(message(error, "Copy failed")),
    );
  };
  return (
    <Tooltip host={host} side="top" label={`${copied ? "Copied" : copyLabel}: ${value}`}>
      <button
        type="button"
        aria-label={copied ? copiedLabel : copyLabel}
        onClick={copy}
        style={{ ...linkButton, textDecoration: "none", minWidth: 0, maxWidth: "100%" }}
      >
        <code style={{ ...chipStyle, display: "block" }}>{copied ? "Copied" : value}</code>
      </button>
    </Tooltip>
  );
}

/**
 * Native's `base ← head` chips; the base keeps up to 45% so a long head
 * cannot squeeze it out. The head copies its branch as native's does;
 * opening a branch on the host is its own ↗ control beside the chip.
 */
function BranchChips(props: {
  host: ClientHost;
  detail: { readonly baseBranch: string; readonly headBranch: string };
  stacked: boolean;
  baseUrl: string | null;
  headUrl: string | null;
  onOpen: (url: string) => void;
  onCopyError: (detail: string) => void;
}) {
  const chips = prsBranchChips(props.detail, props.stacked);
  const openControl = (text: string, url: string | null) =>
    url === null ? null : (
      <Tooltip host={props.host} side="top" label={`Open ${text} on host`}>
        <button
          type="button"
          aria-label={`Open branch ${text} on host`}
          onClick={() => props.onOpen(url)}
          style={{ ...linkButton, textDecoration: "none", flexShrink: 0, fontSize: 11 }}
        >
          ↗
        </button>
      </Tooltip>
    );
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, color: muted }}>
      <Tooltip host={props.host} side="top" label={chips.base.tooltip}>
        <code style={{ ...chipStyle, maxWidth: "45%", flexShrink: 0 }}>
          {chips.base.stacked && <span aria-label="Stacked pull request">⧉ </span>}
          {chips.base.text}
        </code>
      </Tooltip>
      {openControl(chips.base.text, props.baseUrl)}
      <span role="img" aria-label={chips.arrowLabel} style={{ flexShrink: 0 }}>
        ←
      </span>
      <span style={{ display: "inline-flex", flex: 1, minWidth: 0 }}>
        <CopyableCode
          key={chips.head.text}
          host={props.host}
          value={chips.head.text}
          copyLabel="Copy pull request branch"
          copiedLabel="Branch name copied"
          onError={props.onCopyError}
        />
      </span>
      {openControl(chips.head.text, props.headUrl)}
    </span>
  );
}

export function PrListRow(props: {
  host: ClientHost;
  entry: PrsListEntry;
  viewers: Readonly<Record<string, string>>;
  onSelect: () => void;
  loadChecks: (signal: AbortSignal) => Promise<readonly PrsCheck[]>;
  onOpenLink: (url: string) => void;
}) {
  const { host, entry, viewers, onSelect, loadChecks, onOpenLink } = props;
  const review = prsReviewLabel(entry.reviewDecision);
  const stack = prsStackLabel(entry.stack);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          font: "inherit",
          fontSize: 12,
          padding: "5px 8px",
          border: "1px solid transparent",
          borderRadius: 5,
          cursor: "pointer",
          color: "var(--t3-version-control-text, var(--foreground, #20252d))",
          background: "transparent",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {stateBadge(host, entry)}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.title}
          </span>
          <ChecksControl
            host={host}
            state={entry.checksState}
            loadChecks={loadChecks}
            onOpenLink={onOpenLink}
          />
          {entry.viewerReviewRequested && badge("Review requested", "open")}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            marginTop: 2,
            fontSize: 11,
            color: muted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {prsRowMeta(entry)}
            {prsAuthoredByViewer(entry, viewers) ? " · you" : ""}
          </span>
          {review !== null && (
            <Tooltip host={host} side="top" label={prsReviewTooltip(entry.reviewDecision)}>
              {badge(review, review === "Approved" ? "open" : "closed")}
            </Tooltip>
          )}
          {stack !== null && (
            <Tooltip host={host} side="top" label={prsStackTooltip(entry.stack)}>
              {badge(stack, "merged")}
            </Tooltip>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, marginTop: 2 }}>
          <code style={{ ...chipStyle, color: muted }}>{entry.headBranch}</code>
          <span style={{ flexShrink: 0, color: muted, fontSize: 11 }}>→</span>
          <code style={{ ...chipStyle, color: muted, maxWidth: "45%", flexShrink: 0 }}>
            {entry.baseBranch}
          </code>
        </span>
        {entry.labels.length > 0 && (
          <span
            style={{
              display: "flex",
              gap: 4,
              marginTop: 3,
              flexWrap: "wrap",
            }}
          >
            {entry.labels.map((label) => (
              <span
                key={label.name}
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 8,
                  border,
                  color: muted,
                }}
              >
                {label.name}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}

/* ---------------- detail ---------------- */

function metaRow(label: string, value: ReactNode) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "1px 0", fontSize: 12 }}>
      <span style={{ width: 110, flexShrink: 0, color: muted }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function CheckRow({ host, check }: { host: ClientHost; check: PrsCheck }) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        padding: "2px 10px",
        fontSize: 12,
      }}
    >
      <span
        style={{
          color:
            check.status === "success"
              ? "var(--success, #2da44e)"
              : check.status === "failure" || check.status === "action-required"
                ? "var(--t3-version-control-error, var(--destructive, #b42318))"
                : muted,
          flexShrink: 0,
        }}
      >
        {prsCheckStatusLabel(check.status)}
      </span>
      {/* Native's help is the full description, else the name; it sits on
          the clipped description where there is one. */}
      {check.description === null ? (
        <Tooltip host={host} side="top" label={prsCheckTooltip(check)}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{check.name}</span>
        </Tooltip>
      ) : (
        <>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{check.name}</span>
          <Tooltip host={host} side="top" label={prsCheckTooltip(check)}>
            <span
              style={{
                color: muted,
                fontSize: 12,
                flexShrink: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {check.description}
            </span>
          </Tooltip>
        </>
      )}
    </li>
  );
}

function CommentRow({ comment }: { comment: PrsComment }) {
  const verdict = prsReviewVerdictLabel(comment.reviewState);
  return (
    <li style={{ padding: "4px 10px", fontSize: 12, borderTop: hairline }}>
      <div style={{ color: muted, fontSize: 12 }}>
        {prsActorLabel(comment.author)}
        {verdict !== null ? ` ${verdict}` : comment.kind === "review" ? " reviewed" : " commented"}
        {comment.path !== null ? ` on ${comment.path}` : ""} ·{" "}
        {formatRelativeTime(comment.createdAt)}
        {comment.url !== null ? ` — ${comment.url}` : ""}
      </div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2 }}>
        {comment.body}
      </div>
      {comment.reactions !== undefined && comment.reactions.length > 0 && (
        <div style={{ color: muted, fontSize: 12, marginTop: 2 }}>
          {comment.reactions.map((r) => `${r.content} ×${r.count}`).join(" · ")}
        </div>
      )}
    </li>
  );
}

interface PrsThreadWriteControls {
  readonly canReply: boolean;
  readonly canResolve: boolean;
  readonly resolvePending: boolean;
  readonly resolveError: string | null;
  readonly replyPending: boolean;
  readonly replyError: string | null;
  readonly replyDraft: string;
  readonly onReplyDraftChange: (value: string) => void;
  readonly onReply: (threadId: string, body: string) => void;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
}

function ReviewThreadSection(props: {
  thread: PrsReviewThread;
  canPage: boolean;
  onLoadMore: (thread: PrsReviewThread) => void;
  paging: boolean;
  /** The host cut the tail and issued no cursor — a lossy terminal state, named. */
  unrecoverable: boolean;
  /** A paged continuation failed; the cursor is preserved so the button retries it. */
  pageError: string | null;
  /** Write controls for this thread; null where `t3.prs/write` is not ready. */
  write: PrsThreadWriteControls | null;
}) {
  const { thread, canPage, onLoadMore, paging, unrecoverable, pageError, write } = props;
  return (
    <section
      aria-label={`Thread on ${prsThreadAnchor(thread)}`}
      style={{ borderTop: hairline, paddingBottom: 4 }}
    >
      <h4 style={{ ...headingStyle, padding: "4px 10px 2px", textTransform: "none" }}>
        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          {prsThreadAnchor(thread)}
        </span>
        <span style={{ fontWeight: 400 }}> — {prsThreadStateLabel(thread)}</span>
      </h4>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {thread.comments.map((comment) => (
          <li key={comment.id} style={{ padding: "3px 10px", fontSize: 12 }}>
            <div style={{ color: muted, fontSize: 12 }}>
              {prsActorLabel(comment.author)} · {formatRelativeTime(comment.createdAt)}
              {comment.url !== null ? ` — ${comment.url}` : ""}
            </div>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 1 }}>
              {comment.body}
            </div>
            {comment.reactions !== undefined && comment.reactions.length > 0 && (
              <div style={{ color: muted, fontSize: 12, marginTop: 1 }}>
                {comment.reactions.map((r) => `${r.content} ×${r.count}`).join(" · ")}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canPage && prsThreadMoreLabel(thread) !== null && (
        <button
          type="button"
          disabled={paging}
          onClick={() => onLoadMore(thread)}
          style={{ ...iconButton, margin: "2px 10px" }}
        >
          {paging ? "Loading…" : prsThreadMoreLabel(thread)}
        </button>
      )}
      {canPage === false && thread.nextCommentsCursor !== undefined && (
        <p style={{ ...noteStyle, fontSize: 12 }}>
          More comments exist; paging is not supported by this host.
        </p>
      )}
      {pageError !== null && (
        <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
          {pageError} — retry with the button above.
        </p>
      )}
      {unrecoverable && (
        <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
          Some comments could not be shown — the host cut this thread's tail without a cursor.
        </p>
      )}
      {write !== null && (
        <div style={{ padding: "2px 10px" }}>
          {write.canResolve && (
            <button
              type="button"
              disabled={write.resolvePending}
              onClick={() => write.onResolve(thread.id, !thread.isResolved)}
              style={iconButton}
            >
              {write.resolvePending
                ? "Working…"
                : thread.isResolved
                  ? "Unresolve thread"
                  : "Resolve thread"}
            </button>
          )}
          <PrsWriteErrorLine error={write.resolveError} />
          {write.canReply && (
            <PrsComposer
              label="Reply"
              placeholder="Reply to this thread"
              value={write.replyDraft}
              pending={write.replyPending}
              error={write.replyError}
              onChange={write.onReplyDraftChange}
              onSubmit={(body) => write.onReply(thread.id, body)}
            />
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- diff ---------------- */

const diffRowBase = {
  display: "flex",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "pre",
} as const;

const gutter = {
  width: 40,
  flexShrink: 0,
  textAlign: "right" as const,
  paddingRight: 8,
  color: muted,
  userSelect: "none" as const,
};

function PrsDiffRow({ row }: { row: ReturnType<typeof fileRows>[number] }) {
  if (row.kind === "gap") {
    return (
      <div
        style={{
          ...diffRowBase,
          justifyContent: "center",
          color: muted,
          background: "var(--t3-version-control-muted, var(--muted, #f4f5f7))",
          fontStyle: "italic",
        }}
      >
        {row.count} unmodified line{row.count === 1 ? "" : "s"}
      </div>
    );
  }
  const addition = row.kind === "addition";
  const deletion = row.kind === "deletion";
  return (
    <div
      style={{
        ...diffRowBase,
        background: addition
          ? "color-mix(in srgb, var(--success, #2da44e) 14%, transparent)"
          : deletion
            ? "color-mix(in srgb, var(--t3-version-control-error, var(--destructive, #cf222e)) 12%, transparent)"
            : "transparent",
      }}
    >
      <span style={gutter}>{deletion || row.kind === "context" ? row.oldLine : ""}</span>
      <span style={gutter}>{addition || row.kind === "context" ? row.newLine : ""}</span>
      <span style={{ color: muted, userSelect: "none", width: 14 }}>
        {addition ? "+" : deletion ? "−" : " "}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.text}</span>
    </div>
  );
}

const PrsFileSection = memo(function PrsFileSection({
  row,
  enabled,
  viewed,
  stale,
  setViewed,
  host,
}: {
  row: DiffFileRow;
  enabled: boolean;
  viewed: boolean;
  stale: boolean;
  setViewed: (path: string, viewed: boolean) => void;
  host: ClientHost;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(
    () => (collapsed || row.binary || row.textless ? [] : fileRows(row)),
    [collapsed, row],
  );
  return (
    <section aria-label={displayPath(row)} style={{ borderTop: hairline }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          fontSize: 12,
        }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${displayPath(row)}`}
          onClick={() => setCollapsed((value) => !value)}
          style={{ ...iconButton, width: 20, textAlign: "center" }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {displayPath(row)}
          <span style={{ color: muted }}>
            {" "}
            — {row.binary ? "binary" : changeTypeLabel(row.changeType)}
            {fileStatLabel(row) !== "" ? ` ${fileStatLabel(row)}` : ""}
          </span>
        </span>
        {enabled && (
          <label
            data-viewed-toggle=""
            onClick={(event) => event.stopPropagation()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: muted,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              aria-label={stale ? "Changed" : "Viewed"}
              checked={viewed}
              onChange={(event) => {
                setViewed(row.path, event.target.checked);
                setCollapsed(event.target.checked);
              }}
              style={{ margin: 0, accentColor: "var(--primary, #2563eb)" }}
            />
            {stale ? (
              <Tooltip host={host} label="This file has been pushed to since you marked it viewed.">
                <span style={{ color: "var(--warning, #b45309)" }}>Changed</span>
              </Tooltip>
            ) : (
              "Viewed"
            )}
          </label>
        )}
      </header>
      {!collapsed && row.binary && (
        <p role="note" style={noteStyle}>
          {row.path} is a binary file — no text diff is available.
        </p>
      )}
      {!collapsed && row.textless && (
        <p role="note" style={noteStyle}>
          No textual changes in the patch for {displayPath(row)}.
        </p>
      )}
      {!collapsed && rows.map((line) => <PrsDiffRow key={line.ordinal} row={line} />)}
    </section>
  );
});

function PrsDiffSection(props: {
  diff: PrsDiffState;
  supported: boolean;
  onLoadMore: () => void;
  host: ClientHost;
  session: ViewSession;
  reference: PrsRef | null;
  detail: PrsDetail | null;
  write: PrsWriteOperationsSupport | null;
  viewedReadSupported: boolean;
  revision: string;
  onViewedFailure: () => void;
  onViewedSuccess: () => void;
}) {
  const { diff, supported, onLoadMore } = props;
  const viewed = usePrsFilesViewed(
    props.host,
    props.session,
    props.reference,
    props.detail?.capabilities.viewedFiles,
    props.write,
    props.viewedReadSupported,
    props.revision,
    props.onViewedFailure,
    props.onViewedSuccess,
  );
  const patch = diff.status === "ready" ? diff.delivery.patch : "";
  const renderable = useMemo(() => renderableFromPatch(patch), [patch]);
  if (!supported) {
    return (
      <p role="note" style={noteStyle}>
        Diff streaming is not supported by this host (prs.streamDiff).
      </p>
    );
  }
  if (diff.status === "loading") {
    return <p style={noteStyle}>Streaming the verified diff…</p>;
  }
  if (diff.status === "error") {
    return (
      <p role="alert" style={noteStyle}>
        {diff.detail}
      </p>
    );
  }
  const { delivery } = diff;
  return (
    <div>
      <p style={{ ...noteStyle, fontSize: 12 }}>
        {delivery.diffHashes[0] !== undefined
          ? `sha256 ${delivery.diffHashes[0].slice(0, 12)} · ${delivery.byteLength} bytes`
          : "empty diff"}
        {delivery.diffHashes.length > 1 ? ` · ${delivery.diffHashes.length} verified segments` : ""}
        {delivery.truncated ? " · truncated by the host" : ""}
      </p>
      {renderable === null && <p style={noteStyle}>The delivered diff is empty.</p>}
      {renderable !== null && renderable.kind === "raw" && (
        <div>
          <p style={noteStyle}>{renderable.reason}</p>
          <pre
            style={{
              margin: 0,
              padding: "4px 10px",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {renderable.text}
          </pre>
        </div>
      )}
      {renderable !== null && renderable.kind === "files" && (
        <div>
          {viewed.enabled && renderable.files.length > 0 && (
            <p
              style={{ ...noteStyle, display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
            >
              {renderable.files.filter((row) => viewed.file(row.path).viewed).length} /{" "}
              {renderable.files.length}
              {props.detail?.capabilities.viewedFiles === "environment"
                ? " viewed in T3 Code"
                : " viewed"}
              {props.detail?.capabilities.viewedFiles === "environment" && (
                <Tooltip
                  host={props.host}
                  label="This host keeps no shared record of which files you have read, so these ticks are kept by this environment. They follow you between the apps connected to it, but the host's own web UI will not show them."
                >
                  <span aria-label="These ticks are kept here, not on the host">ⓘ</span>
                </Tooltip>
              )}
              {viewed.truncated && (
                <Tooltip
                  host={props.host}
                  label="The host had more files than were read, so this count is short."
                >
                  <span>· partial count</span>
                </Tooltip>
              )}
            </p>
          )}
          {viewed.enabled && viewed.error && (
            <p role="alert" style={noteStyle}>
              Your ticks could not be read. The boxes are whatever was last read, and empty if
              nothing has been read yet.
            </p>
          )}
          {renderable.files.map((row) => (
            <PrsFileSection
              key={row.key}
              row={row}
              enabled={viewed.enabled}
              {...viewed.file(row.path)}
              setViewed={viewed.setViewed}
              host={props.host}
            />
          ))}
        </div>
      )}
      {delivery.omittedFileStats.length > 0 && (
        <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
          {prsOmittedFilesLabel(delivery.omittedFileStats)}
        </p>
      )}
      {delivery.nextCursor !== null && (
        <button
          type="button"
          disabled={diff.loadingMore}
          onClick={onLoadMore}
          style={{ ...iconButton, margin: "4px 10px" }}
        >
          {diff.loadingMore ? "Loading…" : "Load remaining diff"}
        </button>
      )}
    </div>
  );
}

/* ---------------- writes ---------------- */

/** One write in flight at a time — the native panel's own single-flight rule. */
interface PrsWriteState {
  readonly key: string;
  readonly pending: boolean;
  readonly error: string | null;
}

function PrsWriteErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
      {error}
    </p>
  );
}

/**
 * One header write. `disabled` is any write in flight; `pendingAction` is
 * the action that write runs, which alone shows its pending words.
 */
export function PrsActionButton(props: {
  host: ClientHost;
  offer: PrsWriteActionOffer;
  disabled: boolean;
  pendingAction: string | null;
  method: string;
  onMethodChange: (value: string) => void;
  onRun: (offer: PrsWriteActionOffer, method?: string) => void;
}) {
  const { host, offer, disabled, pendingAction, method, onMethodChange, onRun } = props;
  const choices: readonly string[] = offer.methods ?? offer.updateMethods ?? [];
  const presentation = prsActionPresentation(offer.action, method, pendingAction);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <Tooltip
        host={host}
        side="top"
        label={presentation.tooltip}
        showWhenDisabled={presentation.hoverWhileDisabled}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRun(offer, method === "" ? undefined : method)}
          style={{
            ...control,
            color: offer.destructive ? "var(--destructive, #b42318)" : "inherit",
          }}
        >
          {presentation.label}
        </button>
      </Tooltip>
      {choices.length > 1 && (
        <select
          aria-label={`${offer.label} method`}
          value={method}
          onChange={(event) => onMethodChange(event.target.value)}
          style={{ ...control, padding: "2px 4px" }}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/**
 * Native's Check out menu: a trigger that names the running checkout, and
 * the two places a checkout can land. ArrowDown/ArrowUp on the trigger open
 * it on the first/last option, arrow keys move between the options, Escape
 * closes back onto the trigger, and Tab or leaving the menu closes it.
 */
function CheckoutMenu(props: {
  host: ClientHost;
  pending: boolean;
  disabled: boolean;
  options: ReturnType<typeof prsCheckoutOptions>;
  onPick: (mode: PrsCheckoutMode) => void;
}) {
  const { host, pending, disabled, options, onPick } = props;
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (open !== null) items.current[open === "first" ? 0 : items.current.length - 1]?.focus();
  }, [open]);
  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  const move = (step: number) => {
    const focused = typeof document === "undefined" ? null : document.activeElement;
    const at = items.current.findIndex((item) => item === focused);
    const count = options.length;
    items.current[(at + step + count) % count]?.focus();
  };
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <Tooltip host={host} side="top" label="Check out this pull request">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open !== null}
          aria-label={prsCheckoutLabel(pending)}
          disabled={disabled}
          onClick={() => setOpen((value) => (value === null ? "first" : null))}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(event.key === "ArrowDown" ? "first" : "last");
            }
          }}
          style={{ ...control, fontSize: 12, border }}
        >
          {prsCheckoutLabel(pending)} ▾
        </button>
      </Tooltip>
      {open !== null && (
        <div
          role="menu"
          aria-label="Check out"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (event.key === "Tab") {
              // Focus moves on as Tab would; the menu just goes away.
              setOpen(null);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              items.current[event.key === "Home" ? 0 : options.length - 1]?.focus();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null);
          }}
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 10,
            minWidth: 260,
            marginTop: 4,
            padding: 4,
            border,
            borderRadius: 6,
            background:
              "var(--t3-version-control-background, var(--popover, var(--background, #fff)))",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.mode}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onPick(option.mode);
              }}
              style={{
                ...control,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                width: "100%",
                textAlign: "left",
                fontSize: 13,
              }}
            >
              <span>{option.label}</span>
              <span style={{ fontSize: 12, color: muted }}>{option.description}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * Native's confirmation Dialog: modal, labelled by its title and described by
 * its description, first focus on Cancel (never the destructive action), Tab
 * held inside, Escape or Cancel closing it and handing focus back to the
 * control that opened it. A running write cannot be dismissed. Hosts with a
 * modal dialog (floating layer 2) show native's own, centred over an inert
 * client; older hosts get it against its opener on their floating layer, or
 * in place, where the caller makes the panel behind it inert.
 */
function ConfirmDialog(props: {
  host: ClientHost;
  anchor: HTMLElement | null;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const { host, anchor, title, description, confirmLabel, pending, onCancel, onConfirm } = props;
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement | null>(null);
  const confirm = useRef<HTMLButtonElement | null>(null);
  const opener = useRef(anchor);
  const HostDialog = resolveFloatingDialog(host);
  const hosted = HostDialog !== null;
  useEffect(() => {
    // The host dialog places and returns focus itself.
    if (hosted) return;
    cancel.current?.focus();
    const returnTo = opener.current;
    return () => returnTo?.focus();
  }, [hosted]);
  const onKeyDown = (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    const order = pending ? [] : [cancel.current, confirm.current].filter((item) => item !== null);
    if (order.length === 0) return;
    const focused = typeof document === "undefined" ? null : document.activeElement;
    const at = order.findIndex((item) => item === focused);
    const next = event.shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : (at + 1) % order.length;
    order[next]?.focus();
  };
  const dialogProps = {
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": descriptionId,
    onKeyDown,
  } as const;
  const surface = {
    width: 360,
    maxWidth: "calc(100vw - 24px)",
    padding: "10px 12px",
    border,
    borderRadius: 8,
    fontSize: 12,
    color: "var(--t3-version-control-text, var(--foreground, #20252d))",
    background: "var(--t3-version-control-background, var(--popover, var(--background, #fff)))",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.18)",
  } as const;
  const actions = (
    <>
      <button
        ref={cancel}
        type="button"
        disabled={pending}
        onClick={onCancel}
        style={{ ...control, fontSize: 12, border }}
      >
        Cancel
      </button>
      <button
        ref={confirm}
        type="button"
        disabled={pending}
        onClick={onConfirm}
        style={{ ...control, fontSize: 12, border }}
      >
        {pending ? "Working…" : confirmLabel}
      </button>
    </>
  );
  if (HostDialog !== null)
    return (
      <HostDialog
        title={title}
        description={description}
        dismissible={!pending}
        onDismiss={onCancel}
        initialFocus={cancel}
        footer={actions}
      >
        {props.children}
      </HostDialog>
    );
  const body = (
    <>
      <strong id={titleId} style={{ fontSize: 13 }}>
        {title}
      </strong>
      <p id={descriptionId} style={{ margin: "4px 0", color: muted }}>
        {description}
      </p>
      {props.children}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 }}>
        {actions}
      </div>
    </>
  );
  const Popover = resolveFloatingLayer(host)?.Popover;
  if (Popover !== undefined && anchor !== null)
    return (
      <Popover {...dialogProps} anchor={anchor} side="bottom" align="start" style={surface}>
        {body}
      </Popover>
    );
  return (
    <div
      {...dialogProps}
      style={{ ...surface, position: "absolute", top: 36, left: 10, zIndex: 20 }}
    >
      {body}
    </div>
  );
}

/** A receipt in toast form: the tone is the severity, the description the body. */
function receiptToast(receipt: PrsReceipt): MutationToastPatch {
  return {
    severity: receipt.tone,
    title: receipt.title,
    ...(receipt.description !== null ? { body: receipt.description } : {}),
  };
}

function ReceiptLine({ receipt }: { receipt: PrsReceipt | null }) {
  if (receipt === null) return null;
  return (
    <p role={receipt.tone === "error" ? "alert" : "status"} style={{ ...noteStyle, fontSize: 12 }}>
      <strong
        style={{
          color:
            receipt.tone === "error"
              ? "var(--t3-version-control-error, var(--destructive, #b42318))"
              : receipt.tone === "warning"
                ? "var(--warning, #b54708)"
                : "inherit",
        }}
      >
        {receipt.title}
      </strong>
      {receipt.description !== null ? ` — ${receipt.description}` : ""}
    </p>
  );
}

/**
 * Textarea + submit shared by the comment composer, the review bar and
 * thread replies. The draft lives in the panel, not here — a refresh
 * reprobe unmounts the whole ready subtree, and a composer-local
 * useState would silently take the author's words with it.
 */
function PrsComposer(props: {
  label: string;
  placeholder: string;
  value: string;
  pending: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSubmit: (body: string) => void;
}) {
  const { label, placeholder, value, pending, error, onChange, onSubmit } = props;
  return (
    <div style={{ padding: "4px 10px" }}>
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        style={{ ...inputStyle, width: "100%", resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <button
          type="button"
          disabled={pending || value.trim() === ""}
          onClick={() => onSubmit(value)}
          style={control}
        >
          {pending ? `${label}…` : label}
        </button>
      </div>
      <PrsWriteErrorLine error={error} />
    </div>
  );
}

/**
 * The review bar — verdict picker over the host's declared verdicts plus
 * a body. The native rule carries over: an approval needs no words, and
 * anything else does — this panel drafts no line comments to stand in.
 */
function PrsReviewComposer(props: {
  verdicts: readonly { readonly value: PrsWriteVerdict; readonly label: string }[];
  verdict: PrsWriteVerdict;
  body: string;
  pending: boolean;
  error: string | null;
  onVerdictChange: (value: PrsWriteVerdict) => void;
  onBodyChange: (value: string) => void;
  onSubmit: (verdict: PrsWriteVerdict, body: string) => void;
}) {
  const { verdicts, verdict, body, pending, error, onVerdictChange, onBodyChange, onSubmit } =
    props;
  return (
    <div style={{ padding: "4px 10px" }}>
      <textarea
        aria-label="Review body"
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        placeholder={
          verdict === "approve" ? "Review body (optional for an approval)" : "Review body"
        }
        rows={3}
        style={{ ...inputStyle, width: "100%", resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <select
          aria-label="Review verdict"
          value={verdict}
          onChange={(event) => onVerdictChange(event.target.value as PrsWriteVerdict)}
          style={{ ...control, padding: "2px 4px" }}
        >
          {verdicts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || (verdict !== "approve" && body.trim() === "")}
          onClick={() => onSubmit(verdict, body)}
          style={control}
        >
          {pending ? "Submitting…" : "Submit review"}
        </button>
      </div>
      <PrsWriteErrorLine error={error} />
    </div>
  );
}

/* ---------------- panel ---------------- */

const MERGE_METHODS: readonly PrsWriteMergeMethod[] = ["merge", "squash", "rebase"];

/**
 * Native's last-selected merge method, for change requests with no pick of
 * their own, and the per-project method older releases kept on this client.
 * Both live in the host's client-local preferences, the native panel's own
 * storage, so a pick survives remounts and reloads and is shared with the
 * native panel. Hosts without them keep the pick for this panel's lifetime.
 */
function useRememberedMergeMethod(host: ClientHost) {
  const preferences = resolvePullRequestPreferences(host);
  const [local, setLocal] = useState<PrsWriteMergeMethod | null>(null);
  const [, setChanged] = useState(0);
  useEffect(() => preferences?.subscribe(() => setChanged((count) => count + 1)), [preferences]);
  return {
    last: preferences === null ? local : preferences.lastMergeMethod(),
    legacy: (project: { readonly environmentId: string; readonly projectId: string }) =>
      preferences?.legacyProjectMergeMethod(project) ?? undefined,
    remember: (value: string) => {
      const method = MERGE_METHODS.find((candidate) => candidate === value);
      if (method === undefined) return;
      if (preferences === null) setLocal(method);
      else preferences.setLastMergeMethod(method);
    },
  };
}

export function PullRequestsPanel(props: {
  host: ClientHost;
  session: ViewSession;
  visible: boolean;
  selected: PrsRef | null;
  onSelect: (ref: PrsRef | null) => void;
}) {
  const { host, session, visible, selected, onSelect } = props;
  const [tick, setTick] = useState(0);
  const [listState, setListState] = useState<PrsListState>("open");
  const [involvement, setInvolvement] = useState<PrsInvolvement>("all");
  const [query, setQuery] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // One pending comment-page request per (scope, thread), keyed to the
  // activity head it serves — paging a second thread neither re-arms the
  // first thread's button nor lets one settle clear another's marker,
  // and a stale head's in-flight request never suppresses a fresh click.
  const [pagingThreads, setPagingThreads] = useState<ReadonlyMap<string, PrsActivity>>(new Map());
  // Paged-in comment tails keep the new cursor + truncation flag so a
  // thread pages forward instead of refetching the same page. Tails are
  // bound to the exact `activity` payload they extend — a re-read (new
  // object), a refresh, or a selection change retires them wholesale,
  // so a stale page can never append to a freshly read thread head. At
  // most one scope is retained; the next write replaces it.
  const [pagedThreads, setPagedThreads] = useState<{
    readonly scope: string;
    readonly activity: PrsActivity;
    readonly map: ReadonlyMap<
      string,
      {
        readonly comments: readonly PrsThreadComment[];
        readonly nextCursor: string | null;
        readonly truncated: boolean;
        readonly error: string | null;
      }
    >;
  } | null>(null);
  // Advances whenever the scope OR the activity payload changes; a page
  // that resolves under an older generation is dropped before it can
  // touch the map.
  const pagedGeneration = useRef({
    scope: null as string | null,
    activity: null as PrsActivity | null,
    generation: 0,
  });

  const { capabilities, error: capsError } = usePrsCapabilities(host, session, visible, tick);
  const gate = prsGate(capabilities, capsError);
  const ready = gate.kind === "ready";
  const ops = ready ? gate.operations : null;

  // The write probe runs only once reads are live — probing a host that
  // cannot even read would answer a misleading unavailability.
  const writeProbe = usePrsWriteCapabilities(host, session, visible && ready, tick);
  const write = prsWriteGate(writeProbe.capabilities, writeProbe.error);
  const writeOps = write.kind === "ready" ? write.operations : null;
  /**
   * Drafts live HERE, above the capability-gated subtree — a completed
   * invalidation bumps `tick`, the probes return null while they re-read,
   * and `ready` unmounts every composer. Composer-local state dies with
   * the subtree; panel state survives it. Keys are `${prsRefKey}:${kind}`
   * so a draft belongs to its PR and its composer — a posted comment
   * clears only the submitted version of its own text.
   */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [writeState, setWriteState] = useState<PrsWriteState | null>(null);
  const rememberedMergeMethod = useRememberedMergeMethod(host);
  const [openError, setOpenError] = useState<string | null>(null);
  // The handoff in flight (native's `handoff` key: `checkout:<mode>`), and
  // the last one's receipt, bound to the PR it answered.
  // An armed stack merge (the PR it was armed on) and its last receipt.
  const [stackConfirm, setStackConfirm] = useState<{
    readonly refKey: string;
    readonly action: "merge" | "rebase";
    readonly opener: HTMLElement | null;
    /** The plan a running write was started with: native keeps its dialog until it settles. */
    readonly running?: ReturnType<typeof prsStackMergePlan> | ReturnType<typeof prsStackRebasePlan>;
  } | null>(null);
  const stackMergeOpener = useRef<HTMLButtonElement | null>(null);
  const stackRebaseOpener = useRef<HTMLButtonElement | null>(null);
  const [stackReceipt, setStackReceipt] = useState<{
    readonly refKey: string;
    readonly receipt: PrsReceipt;
  } | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [handoffReceipt, setHandoffReceipt] = useState<{
    readonly refKey: string;
    readonly receipt: PrsReceipt;
  } | null>(null);
  const [viewedFailureKey, setViewedFailureKey] = useState<string | null>(null);

  /** Hands a host URL to the reader's own client (`t3.ui/external`); a refusal is said by name. */
  const openOnHost = (url: string) => {
    setOpenError(null);
    void bindApi(uiExternalApi, host, session.context)
      .invoke("open", { url }, session.signal)
      .then(
        (receipt) => {
          if (!session.signal.aborted && receipt.status === "refused")
            setOpenError(prsOpenRefusedLabel(receipt.reason));
        },
        (error) => {
          if (!session.signal.aborted) setOpenError(message(error, "Could not open the link"));
        },
      );
  };

  const refreshes = usePrsRefreshes(
    host,
    session,
    visible && ready && ops?.["prs.subscribeRefreshes"] === true,
  );
  // The re-read revision folds the manual refresh tick with the host's
  // own refresh events; either one re-reads list and detail.
  const revision = `${tick}:${refreshes.tick}`;

  const debouncedQuery = useDebounced(query, 250);
  const listInput = useMemo(
    () => prsListInput(listState, involvement, debouncedQuery),
    [listState, involvement, debouncedQuery],
  );
  const list = usePrsList(
    host,
    session,
    visible && ready && ops?.["prs.list"] === true,
    listInput,
    revision,
  );
  const sections = usePrsDetail(host, session, selected, ops, revision);
  const { diff, loadMore } = usePrsDiff(
    host,
    session,
    selected,
    visible && ready && selected !== null && ops?.["prs.streamDiff"] === true,
    revision,
  );

  const runInvalidate = () => {
    setViewedFailureKey(null);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(prsReadApi, host, session.context);
    // Listing freshness needs the empty invalidation; the selected PR's
    // detail cache needs its own reference — send both, and re-read only
    // after the host has actually invalidated.
    const invalidations = [api.invoke("invalidate", {}, signal)];
    if (selected !== null)
      invalidations.push(api.invoke("invalidate", { reference: selected }, signal));
    if (selected !== null && ops?.["prs.filesViewed"] === true)
      invalidations.push(
        bindApi(prsReadApi, host, session.context, "^1.2.0").invoke(
          "invalidate",
          { reference: selected, filesViewedOnly: true },
          signal,
        ),
      );
    void Promise.all(invalidations)
      .then(
        () => {
          if (signal.aborted) return;
          setRefreshError(null);
          setTick((value) => value + 1);
        },
        (error) => {
          if (!signal.aborted) setRefreshError(message(error, "Pull-request refresh unavailable"));
        },
      )
      .finally(() => controller.abort());
  };

  const selectedKey = selected === null ? null : prsRefKey(selected);
  const checkoutSupport = useCheckoutSupport(host, session, visible && ready && selected !== null);
  const defaultRefs = useDefaultRefs(
    host,
    session,
    visible && ready && selected !== null,
    revision,
  );
  const toasts = useMutationToasts(host, session, visible && ready);
  /**
   * Starts one outcome's report: native's toast when the host delivers
   * them, else — or once delivery is lost — the inline receipt.
   */
  const beginReport = (
    label: string,
    startTitle: string | undefined,
    showInline: (receipt: PrsReceipt) => void,
  ) => {
    let settled: PrsReceipt | null = null;
    let lost = false;
    const toast = toasts.begin(
      label,
      () => {
        lost = true;
        if (settled !== null) showInline(settled);
      },
      startTitle,
    );
    return (receipt: PrsReceipt) => {
      settled = receipt;
      if (toast === null || lost) showInline(receipt);
      else toast.settleWith(receiptToast(receipt));
    };
  };

  /** Native's stack actions show their result alone: one toast, or inline without them. */
  const reportResult = (receipt: PrsReceipt, showInline: (receipt: PrsReceipt) => void) => {
    if (!toasts.report(receiptToast(receipt), () => showInline(receipt))) showInline(receipt);
  };

  /**
   * The host runs native's handoff (`handoffPullRequest`): it opens the thread,
   * checks out, writes any task into the composer, and reports each outcome
   * in native's toasts on the thread it opened. The pack names the task only,
   * and speaks only for a call the host refused.
   */
  const startHandoff = (
    url: string,
    task: VcsPullRequestHandoffTask,
    mode: PrsCheckoutMode = "worktree",
  ) => {
    if (selectedKey === null || handoff !== null) return;
    const refKey = selectedKey;
    setHandoff(task === "checkout" ? `checkout:${mode}` : "conflicts");
    setHandoffReceipt(null);
    // Host-owned once accepted: opening its thread disposes this view, so the call does not take
    // the view's signal. Uninstall, disable and lost grants still stop it on the host.
    void bindApi(vcsActionsApi, host, session.context, "^1.1.0")
      .invoke(
        "handoffPullRequest",
        task === "checkout" ? { reference: url, task, mode } : { reference: url, task },
        new AbortController().signal,
      )
      .then(
        () => {
          if (!session.signal.aborted) setHandoff(null);
        },
        (error: unknown) => {
          if (session.signal.aborted) return;
          setHandoff(null);
          reportResult(
            prsCheckoutReceipt(mode, {
              ok: false,
              detail: error instanceof Error ? error.message : null,
            }),
            (receipt) => setHandoffReceipt({ refKey, receipt }),
          );
        },
      );
  };

  /** `t3.vcs/actions` prepares the checkout; the receipt names where it landed. */
  const startCheckout = (url: string, mode: PrsCheckoutMode) => {
    if (checkoutSupport.handoff) return startHandoff(url, "checkout", mode);
    if (selectedKey === null || handoff !== null) return;
    const refKey = selectedKey;
    setHandoff(`checkout:${mode}`);
    setHandoffReceipt(null);
    const report = beginReport("Check out", "Preparing the pull request checkout...", (receipt) =>
      setHandoffReceipt({ refKey, receipt }),
    );
    void bindApi(vcsActionsApi, host, session.context)
      .invoke("preparePullRequestThread", { reference: url, mode }, session.signal)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          detail: error instanceof Error ? error.message : null,
        }),
      )
      .then((outcome) => {
        if (session.signal.aborted) return;
        setHandoff(null);
        report(prsCheckoutReceipt(mode, outcome));
      });
  };
  const draftKey = (key: string) => prsDraftKey(selectedKey, key);
  const draft = (key: string) => drafts[draftKey(key)] ?? "";
  const setDraft = (key: string, value: string) =>
    setDrafts((current) => ({ ...current, [draftKey(key)]: value }));

  /**
   * Single-flight write runner — one invoke at a time so two clicks can
   * never double-post. A settled write re-reads through `runInvalidate`;
   * a failed one keeps its named error on the control that asked.
   * `settled` names the draft entries the write consumed (a review eats
   * its body AND its verdict): success clears each ONLY if it is still
   * the submitted version — edits made while the request was in flight
   * are newer work and stay.
   */
  const runWrite = (
    key: string,
    invoke: (signal: AbortSignal) => Promise<unknown>,
    settled?: readonly { readonly key: string; readonly submitted: string }[],
    onSettled?: (
      outcome: { readonly ok: true } | { readonly ok: false; readonly detail: string },
    ) => void,
  ) => {
    if (writeState?.pending) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    setWriteState({ key, pending: true, error: null });
    void invoke(signal).then(
      () => {
        if (signal.aborted) return;
        setWriteState(null);
        if (settled !== undefined && settled.length > 0) {
          setDrafts((current) =>
            settled.reduce(
              (acc, entry) => settlePrsDraft(acc, draftKey(entry.key), entry.submitted),
              current,
            ),
          );
        }
        onSettled?.({ ok: true });
        runInvalidate();
      },
      (error) => {
        if (signal.aborted) return;
        const detail = message(error, "Pull-request write failed");
        setWriteState({ key, pending: false, error: detail });
        onSettled?.({ ok: false, detail });
      },
    );
  };
  const writeApi = () => bindApi(prsWriteApi, host, session.context);
  const writeError = (key: string) =>
    writeState !== null && !writeState.pending && writeState.key === key ? writeState.error : null;
  const writePending = (key: string) =>
    writeState !== null && writeState.pending && writeState.key === key;

  const runPrAction = (offer: PrsWriteActionOffer, method?: string) => {
    if (selected === null) return;
    runWrite(
      `action:${offer.action}`,
      (signal) =>
        writeApi().invoke(
          "runAction",
          {
            ...selected,
            action: offer.action,
            ...((offer.action === "merge" || offer.action === "enable-auto-merge") &&
            method !== undefined
              ? { mergeMethod: method as PrsWriteMergeMethod }
              : {}),
            ...(offer.action === "update-branch" && method !== undefined
              ? { updateMethod: method as PrsWriteUpdateMethod }
              : {}),
          },
          signal,
        ),
      [{ key: `method:${offer.action}`, submitted: method ?? "" }],
    );
  };

  /**
   * Per-thread write controls. `selected` is bound into each callback at
   * render time — a selection change rebuilds every control, so a reply
   * can never land on the PR the reader has since left.
   */
  const threadWrite = (thread: PrsReviewThread): PrsThreadWriteControls | null => {
    if (selected === null || write.kind !== "ready") return null;
    const ref = selected;
    const replyKey = `reply:${thread.id}`;
    return {
      canReply: write.operations["prs.replyToThread"],
      canResolve: write.operations["prs.setThreadResolution"],
      resolvePending: writePending(`resolve:${thread.id}`),
      resolveError: writeError(`resolve:${thread.id}`),
      replyPending: writePending(replyKey),
      replyError: writeError(replyKey),
      replyDraft: draft(replyKey),
      onReplyDraftChange: (value) => setDraft(replyKey, value),
      onReply: (threadId, body) =>
        runWrite(
          replyKey,
          (signal) => writeApi().invoke("replyToThread", { ...ref, threadId, body }, signal),
          [{ key: replyKey, submitted: body }],
        ),
      onResolve: (threadId, resolved) =>
        runWrite(`resolve:${threadId}`, (signal) =>
          writeApi().invoke("setThreadResolution", { ...ref, threadId, resolved }, signal),
        ),
    };
  };

  const pagedScope = selectedKey === null ? null : `${revision}\n${selectedKey}`;
  useEffect(() => {
    const current = pagedGeneration.current;
    if (current.scope !== pagedScope || current.activity !== sections.activity)
      pagedGeneration.current = {
        scope: pagedScope,
        activity: sections.activity,
        generation: current.generation + 1,
      };
  }, [pagedScope, sections.activity]);
  const loadThreadComments = (thread: PrsReviewThread) => {
    if (
      selected === null ||
      pagedScope === null ||
      sections.activity === null ||
      thread.nextCommentsCursor === undefined
    )
      return;
    const cursor = thread.nextCommentsCursor;
    const scope = pagedScope;
    const head = sections.activity;
    const generation = pagedGeneration.current.generation;
    const pendingKey = `${scope}\n${thread.id}`;
    // A second click while the same page is in flight would re-request the
    // identical cursor — the response would re-append the same comments.
    // A marker carrying an older head belongs to a dead generation and
    // must not suppress the click.
    if (pagingThreads.get(pendingKey) === head) return;
    setPagingThreads((prev) => new Map(prev).set(pendingKey, head));
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(prsReadApi, host, session.context)
      .invoke("threadComments", { ...selected, threadId: thread.id, cursor }, signal)
      .then(
        (page) => {
          if (signal.aborted || generation !== pagedGeneration.current.generation) return;
          setPagedThreads((prev) => {
            // Re-validate inside the updater: the response must answer the
            // live scope AND head. A stale-head response is dropped; a
            // current response replaces a stored map whose head is obsolete.
            const current = pagedGeneration.current;
            if (scope !== current.scope || head !== current.activity) return prev;
            const map = new Map(
              prev !== null && prev.scope === scope && prev.activity === head
                ? prev.map
                : undefined,
            );
            const prior = map.get(thread.id);
            map.set(thread.id, {
              comments: mergeThreadComments(prior?.comments ?? [], page.comments),
              nextCursor: page.nextCursor,
              truncated: page.truncated,
              error: null,
            });
            return { scope, activity: head, map };
          });
        },
        (error) => {
          if (signal.aborted || generation !== pagedGeneration.current.generation) return;
          // The fetched tail and the failed cursor survive — the failure
          // is named on the thread and the same button retries the page.
          setPagedThreads((prev) => {
            const current = pagedGeneration.current;
            if (scope !== current.scope || head !== current.activity) return prev;
            const map = new Map(
              prev !== null && prev.scope === scope && prev.activity === head
                ? prev.map
                : undefined,
            );
            const prior = map.get(thread.id);
            map.set(thread.id, {
              comments: prior?.comments ?? [],
              nextCursor: prior?.nextCursor ?? thread.nextCommentsCursor ?? null,
              truncated: prior?.truncated ?? false,
              error: message(error, "Comments unavailable"),
            });
            return { scope, activity: head, map };
          });
        },
      )
      .finally(() => {
        // Clear only this request's marker — a newer request for the same
        // thread under a different head must not lose its own entry.
        setPagingThreads((prev) => {
          if (prev.get(pendingKey) !== head) return prev;
          const next = new Map(prev);
          next.delete(pendingKey);
          return next;
        });
        controller.abort();
      });
  };

  const detail = sections.detail;
  const activity = sections.activity;
  // Offered only where the host can run the handoff; it owns the thread and the prompt.
  const resolveConflicts =
    detail !== null && checkoutSupport.handoff
      ? prsResolveConflictsControl(detail, handoff)
      : { visible: false, label: "Resolve conflicts", disabled: true };
  // On a stack layer a plain merge would land this layer alone into its base,
  // so single merges wait until the stack lookup says there is no stack.
  const singleMergeAllowed = prsSingleMergeAllowed({
    supportsStackActions:
      ops?.["prs.stack"] === true &&
      detail?.capabilities.stacks === true &&
      detail.capabilities.stackActions === true,
    hasStack: sections.stack !== null && sections.stack.layers.length > 0,
    stackPending: !sections.stackFresh,
    stackError: sections.stackError,
  });
  const repositoryUrl = detail === null ? null : prsRepositoryUrl(detail.url);
  // The list row for this PR may be a newer snapshot, with a newer checks rollup.
  const selectedEntry =
    selectedKey === null
      ? undefined
      : list.entries.find((entry) => prsRefKey(entry) === selectedKey);
  const checksRollup =
    detail === null
      ? null
      : prsReconcileChecks(
          detail.checks,
          { ...detail, receivedAt: sections.detailReceivedAt },
          selectedEntry === undefined || selectedKey === null
            ? undefined
            : { ...selectedEntry, receivedAt: list.receivedAt[selectedKey] ?? 0 },
        );
  const checksHeading =
    detail === null || checksRollup === null
      ? null
      : checksRollup.stale
        ? (prsChecksIcon(checksRollup.state)?.label ?? "No checks reported")
        : prsChecksSummary(detail.checks);
  const allowedMergeMethods = detail === null ? [] : prsAllowedMergeMethods(detail);
  // One method for merge, auto-merge and the stack merge, resolved as native does.
  const mergeMethod = prsResolveMergeMethod(
    allowedMergeMethods,
    draft("method:merge") || null,
    detail === null
      ? undefined
      : (detail.preferredMergeMethod ??
          rememberedMergeMethod.legacy({
            environmentId: session.context.resource.environmentId,
            projectId: detail.projectId,
          })),
    rememberedMergeMethod.last,
  );
  const pickMergeMethod = (value: string) => {
    setDraft("method:merge", value);
    rememberedMergeMethod.remember(value);
  };
  // Native requires a fresh stack read: a stack that failed to re-read, or whose
  // re-read is still in flight, offers no merge.
  const stackMerge =
    detail !== null &&
    selected !== null &&
    sections.stack !== null &&
    sections.stackFresh &&
    sections.stackError === null &&
    write.kind === "ready" &&
    prsCanMergeStack(detail, write)
      ? prsStackMergePlan(sections.stack, selected.number, mergeMethod)
      : null;
  // Native's Rebase stack: the same fresh-stack rule, gated on the viewer's own permission.
  const stackRebase =
    detail !== null &&
    sections.stack !== null &&
    sections.stack.layers.length > 0 &&
    sections.stackFresh &&
    sections.stackError === null &&
    write.kind === "ready" &&
    prsCanRebaseStack(detail, write)
      ? prsStackRebasePlan(sections.stack)
      : null;
  const openStackConfirm = (action: "merge" | "rebase") => {
    if (selectedKey === null) return;
    const opener = action === "merge" ? stackMergeOpener : stackRebaseOpener;
    setStackConfirm({ refKey: selectedKey, action, opener: opener.current });
  };
  const confirmPlan =
    stackConfirm === null || stackConfirm.refKey !== selectedKey
      ? null
      : (stackConfirm.running ?? (stackConfirm.action === "merge" ? stackMerge : stackRebase));
  const confirming = confirmPlan !== null ? stackConfirm : null;
  const stackActionPending = confirming !== null && writePending(`stack:${confirming.action}`);
  const runStackAction = () => {
    if (
      selected === null ||
      selectedKey === null ||
      confirming === null ||
      confirmPlan === null ||
      confirmPlan.disabled
    )
      return;
    const ref = selected;
    const refKey = selectedKey;
    const { action } = confirming;
    setStackConfirm({ ...confirming, running: confirmPlan });
    setStackReceipt(null);
    runWrite(
      `stack:${action}`,
      (signal) => writeApi().invoke("runAction", { ...ref, ...confirmPlan.input }, signal),
      undefined,
      (outcome) => {
        setStackConfirm(null);
        reportResult(
          action === "merge" ? prsStackMergeReceipt(outcome) : prsStackRebaseReceipt(outcome),
          (receipt) => setStackReceipt({ refKey, receipt }),
        );
      },
    );
  };
  const commitUrl = (oid: string) =>
    detail === null ? null : prsCommitUrl(detail.provider, repositoryUrl, oid);
  const closeConfirmation = () => setStackConfirm(null);

  return (
    <div
      aria-label="Pull requests"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      <div
        inert={confirming !== null}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderBottom: hairline,
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        {selected === null ? (
          <>
            <span role="group" aria-label="State filter" style={{ display: "flex", gap: 2 }}>
              {PRS_LIST_STATES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={listState === option.value}
                  onClick={() => setListState(option.value)}
                  style={{
                    ...iconButton,
                    fontWeight: listState === option.value ? 600 : 400,
                    background:
                      listState === option.value
                        ? "var(--t3-version-control-accent-surface, var(--accent, #e8eef7))"
                        : "transparent",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </span>
            <select
              aria-label="Involvement"
              value={involvement}
              onChange={(event) => setInvolvement(event.target.value as PrsInvolvement)}
              style={{ ...control, padding: "2px 4px" }}
            >
              {PRS_INVOLVEMENTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Search pull requests"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              style={{ ...inputStyle, maxWidth: 160 }}
            />
          </>
        ) : (
          <Tooltip host={host} side="top" label="Back to pull requests">
            <button
              type="button"
              aria-label="Back to this thread's pull requests"
              onClick={() => onSelect(null)}
              style={control}
            >
              ← Pull requests
            </button>
          </Tooltip>
        )}
        {ready && ops?.["prs.invalidate"] === true && (
          <button type="button" onClick={runInvalidate} style={control}>
            Refresh
          </button>
        )}
      </div>

      <div inert={confirming !== null} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {gate.kind === "loading" && (
          <p role="note" style={noteStyle}>
            Reading pull-request capabilities…
          </p>
        )}
        {gate.kind === "error" && (
          <p role="alert" style={noteStyle}>
            Pull requests unavailable — {gate.detail}
          </p>
        )}
        {gate.kind === "unavailable" && (
          <div>
            <p role="alert" style={noteStyle}>
              {prsUnavailableLabel(gate.reason)}
              {gate.detail !== null ? ` — ${gate.detail}` : ""}
            </p>
            {gate.providers.map((provider) => (
              <p key={provider.host} style={{ ...noteStyle, fontSize: 12 }}>
                {prsProviderLabel(provider)}
              </p>
            ))}
          </div>
        )}

        {ready && (
          <>
            {refreshError !== null && (
              <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
                {refreshError}
              </p>
            )}
            {refreshes.detail !== null && (
              <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                {refreshes.detail}
              </p>
            )}

            {selected === null && (
              <div>
                {ops !== null && ops["prs.list"] !== true && (
                  <p role="note" style={noteStyle}>
                    Listing pull requests is not supported by this host (prs.list).
                  </p>
                )}
                {gate.providers.map((provider) => (
                  <p key={provider.host} style={{ ...noteStyle, fontSize: 12 }}>
                    {prsProviderLabel(provider)}
                  </p>
                ))}
                {list.error !== null && (
                  <p role="alert" style={noteStyle}>
                    {list.error}
                  </p>
                )}
                {list.result !== null &&
                  list.result.errors.map((entryError) => (
                    <p
                      key={entryError.projectId}
                      role="alert"
                      style={{ ...noteStyle, fontSize: 12 }}
                    >
                      {entryError.projectTitle}: {entryError.message}
                    </p>
                  ))}
                {list.result !== null && list.result.truncated && (
                  <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                    Results truncated by the host — narrow the search to see more.
                  </p>
                )}
                <ul style={{ listStyle: "none", margin: 0, padding: "2px 4px" }}>
                  {list.entries.map((prEntry) => (
                    <PrListRow
                      key={prsRefKey(prEntry)}
                      host={host}
                      entry={prEntry}
                      viewers={list.result?.viewers ?? {}}
                      loadChecks={(signal) =>
                        bindApi(prsReadApi, host, session.context)
                          .invoke(
                            "detail",
                            {
                              host: prEntry.host,
                              repository: prEntry.repository,
                              number: prEntry.number,
                            },
                            AbortSignal.any([signal, session.signal]),
                          )
                          .then((read) => read.checks)
                      }
                      onOpenLink={openOnHost}
                      onSelect={() =>
                        onSelect({
                          host: prEntry.host,
                          repository: prEntry.repository,
                          number: prEntry.number,
                        })
                      }
                    />
                  ))}
                </ul>
                {!list.pending &&
                  list.error === null &&
                  list.result !== null &&
                  list.result.errors.length === 0 &&
                  list.entries.length === 0 &&
                  ops?.["prs.list"] === true && (
                    <p style={noteStyle}>
                      No {listState === "all" ? "" : `${listState} `}pull requests
                      {involvement !== "all" ? ` (${involvement})` : ""}
                      {debouncedQuery.trim() !== "" ? ` matching “${debouncedQuery.trim()}”` : ""}.
                    </p>
                  )}
                {list.pending && list.entries.length === 0 && (
                  <p style={noteStyle}>Reading pull requests…</p>
                )}
                {prsListHasMore(list.result) && (
                  <button
                    type="button"
                    disabled={list.loadingMore}
                    onClick={list.loadMore}
                    style={{ ...control, margin: "4px 10px" }}
                  >
                    {list.loadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            )}

            {selected !== null && (
              <div>
                {ops !== null && ops["prs.detail"] !== true && (
                  <p role="note" style={noteStyle}>
                    Pull-request detail is not supported by this host (prs.detail).
                  </p>
                )}
                {detail === null && sections.detailError === null && (
                  <p style={noteStyle}>Reading pull request…</p>
                )}
                {sections.detailError !== null && (
                  <p role="alert" style={noteStyle}>
                    {sections.detailError}
                    {detail !== null ? " — showing the last successful read." : ""}
                  </p>
                )}
                {detail !== null && (
                  <div>
                    <div style={{ padding: "6px 10px 2px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        {stateBadge(host, detail)}
                        <Tooltip host={host} side="top" label={detail.title}>
                          <strong style={{ fontSize: 14, overflowWrap: "anywhere" }}>
                            {detail.title}
                          </strong>
                        </Tooltip>
                        <Tooltip
                          host={host}
                          side="top"
                          label={
                            repositoryUrl !== null
                              ? `Open ${detail.repository} repository`
                              : detail.repository
                          }
                        >
                          {repositoryUrl !== null ? (
                            <button
                              type="button"
                              onClick={() => openOnHost(repositoryUrl)}
                              style={{ ...linkButton, color: muted, fontSize: 12 }}
                            >
                              {detail.repository}
                            </button>
                          ) : (
                            <span style={{ color: muted, fontSize: 12 }}>{detail.repository}</span>
                          )}
                        </Tooltip>
                        <Tooltip host={host} side="top" label={prsOpenOnHostLabel(detail.provider)}>
                          <button
                            type="button"
                            aria-label={`Open pull request #${detail.number} on host`}
                            onClick={() => openOnHost(detail.url)}
                            style={{ ...linkButton, fontSize: 12 }}
                          >
                            #{detail.number} ↗
                          </button>
                        </Tooltip>
                        <ChecksControl
                          host={host}
                          state={checksRollup?.state}
                          checks={detail.checks}
                          stale={checksRollup?.stale === true}
                          onOpenLink={openOnHost}
                        />
                        {(checkoutSupport.checkout || resolveConflicts.visible) && (
                          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
                            {checkoutSupport.checkout && (
                              <CheckoutMenu
                                host={host}
                                pending={handoff?.startsWith("checkout") === true}
                                disabled={handoff !== null}
                                options={prsCheckoutOptions(checkoutSupport.handoff)}
                                onPick={(mode) => startCheckout(detail.url, mode)}
                              />
                            )}
                            {resolveConflicts.visible && (
                              <Tooltip
                                host={host}
                                side="top"
                                label={resolveConflicts.label}
                                showWhenDisabled
                              >
                                <button
                                  type="button"
                                  aria-label={resolveConflicts.label}
                                  disabled={resolveConflicts.disabled}
                                  onClick={() => startHandoff(detail.url, "resolve-conflicts")}
                                  style={{
                                    ...control,
                                    fontSize: 12,
                                    border:
                                      "1px solid var(--t3-version-control-error, var(--destructive, #b42318))",
                                    color:
                                      "var(--t3-version-control-error, var(--destructive, #b42318))",
                                  }}
                                >
                                  {resolveConflicts.label}
                                </button>
                              </Tooltip>
                            )}
                          </span>
                        )}
                      </div>
                      <div style={{ color: muted, fontSize: 12, marginTop: 2 }}>{detail.url}</div>
                      <ReceiptLine
                        receipt={
                          handoffReceipt?.refKey === selectedKey ? handoffReceipt.receipt : null
                        }
                      />
                      {openError !== null && (
                        <p role="alert" style={{ ...noteStyle, padding: "2px 0", fontSize: 12 }}>
                          {openError}
                        </p>
                      )}
                    </div>
                    <div style={{ padding: "4px 10px" }}>
                      {metaRow(
                        "Author",
                        <Tooltip host={host} side="top" label={prsActorTooltip(detail.author)}>
                          <span>{prsActorLabel(detail.author)}</span>
                        </Tooltip>,
                      )}
                      {metaRow(
                        "Branches",
                        <BranchChips
                          host={host}
                          detail={detail}
                          stacked={prsStackedOnDefault(detail.baseBranch, defaultRefs ?? [])}
                          baseUrl={prsBranchUrl(detail.provider, repositoryUrl, detail.baseBranch)}
                          headUrl={prsBranchUrl(
                            detail.provider,
                            prsHeadRepositoryUrl(
                              repositoryUrl,
                              detail.repository,
                              detail.headRepositoryNameWithOwner,
                            ),
                            detail.headBranch,
                          )}
                          onOpen={openOnHost}
                          onCopyError={setOpenError}
                        />,
                      )}
                      {metaRow(
                        "Changes",
                        `+${detail.additions} −${detail.deletions} · ${detail.changedFiles} file${
                          detail.changedFiles === 1 ? "" : "s"
                        }`,
                      )}
                      {metaRow(
                        "Mergeability",
                        <Tooltip host={host} side="top" label={prsConflictTooltip(detail)}>
                          <span>{prsMergeabilityLabel(detail.mergeability)}</span>
                        </Tooltip>,
                      )}
                      {detail.baseComparison !== undefined &&
                        metaRow(
                          "Base",
                          detail.baseComparison === "behind"
                            ? `behind ${detail.baseBranch}${detail.behindBy !== undefined ? ` by ${detail.behindBy}` : ""}`
                            : detail.baseComparison,
                        )}
                      {detail.autoMergeEnabled === true &&
                        metaRow(
                          "Auto-merge",
                          <Tooltip
                            host={host}
                            side="top"
                            label={prsArmedAutoMergeTooltip(detail.autoMergeMethod)}
                          >
                            <span>{detail.autoMergeMethod ?? "enabled"}</span>
                          </Tooltip>,
                        )}
                      {detail.workflowApprovalsRequired !== undefined &&
                        detail.workflowApprovalsRequired > 0 &&
                        metaRow(
                          "Approvals",
                          `${detail.workflowApprovalsRequired} workflow approval${
                            detail.workflowApprovalsRequired === 1 ? "" : "s"
                          } required`,
                        )}
                      {metaRow("Created", formatRelativeTime(detail.createdAt))}
                      {metaRow("Updated", formatRelativeTime(detail.updatedAt))}
                      {detail.mergedAt !== null &&
                        metaRow("Merged", formatRelativeTime(detail.mergedAt))}
                      {detail.closedAt !== null &&
                        metaRow("Closed", formatRelativeTime(detail.closedAt))}
                      {selected !== null &&
                        metaRow(
                          "Reviewers",
                          <PrsMetadataPicker
                            key={`${selectedKey}:reviewers`}
                            kind="reviewers"
                            host={host}
                            session={session}
                            reference={selected}
                            detail={detail}
                            readOperations={ops}
                            writeOperations={writeOps}
                            report={toasts.report}
                          />,
                        )}
                      {selected !== null &&
                        (detail.labels.length > 0 || detail.capabilities.labels === true) &&
                        metaRow(
                          "Labels",
                          <PrsMetadataPicker
                            key={`${selectedKey}:labels`}
                            kind="labels"
                            host={host}
                            session={session}
                            reference={selected}
                            detail={detail}
                            readOperations={ops}
                            writeOperations={writeOps}
                            report={toasts.report}
                          />,
                        )}
                    </div>
                    {detail.body !== "" && (
                      <pre
                        style={{
                          margin: "2px 10px",
                          padding: "6px 8px",
                          fontSize: 12,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          background: "var(--t3-version-control-muted, var(--muted, #f4f5f7))",
                          borderRadius: 5,
                          maxHeight: 220,
                          overflow: "auto",
                        }}
                      >
                        {detail.body}
                      </pre>
                    )}
                    {detail.bodyTruncated === true && (
                      <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                        Description truncated by the contract bound — read the rest on the host.
                      </p>
                    )}
                  </div>
                )}

                {detail !== null && write.kind === "ready" && (
                  <section
                    aria-label="Pull request actions"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                      padding: "4px 10px",
                      borderTop: "1px solid var(--border, #f0f2f5)",
                    }}
                  >
                    {writeOps !== null && writeOps["prs.runAction"] !== true && (
                      <p role="note" style={{ ...noteStyle, fontSize: 12, padding: 0 }}>
                        This host takes no pull-request actions.
                      </p>
                    )}
                    {writeOps?.["prs.runAction"] === true &&
                      prsWriteActionOffers(detail, write, { singleMergeAllowed }).map((offer) => (
                        <PrsActionButton
                          key={offer.action}
                          host={host}
                          offer={offer}
                          disabled={writeState?.pending === true}
                          pendingAction={
                            writeState?.pending === true && writeState.key.startsWith("action:")
                              ? writeState.key.slice("action:".length)
                              : null
                          }
                          method={
                            offer.methods !== undefined
                              ? mergeMethod
                              : draft(`method:${offer.action}`) || offer.updateMethods?.[0] || ""
                          }
                          onMethodChange={(value) =>
                            offer.methods !== undefined
                              ? pickMergeMethod(value)
                              : setDraft(`method:${offer.action}`, value)
                          }
                          onRun={runPrAction}
                        />
                      ))}
                    <PrsWriteErrorLine
                      error={
                        writeState !== null &&
                        !writeState.pending &&
                        writeState.key.startsWith("action:")
                          ? writeState.error
                          : null
                      }
                    />
                  </section>
                )}

                {/* Outside the Stack section: a merged stack can vanish on the next read. */}
                <ReceiptLine
                  receipt={stackReceipt?.refKey === selectedKey ? stackReceipt.receipt : null}
                />
                {sections.stackError !== null && (
                  <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
                    {sections.stackError}
                  </p>
                )}
                {ops !== null && ops["prs.stack"] !== true && (
                  <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                    Stack information is not supported by this host (prs.stack).
                  </p>
                )}
                {sections.stack !== null && sections.stack.layers.length > 0 && (
                  <section aria-label="Stack" style={{ paddingBottom: 4 }}>
                    <h3 style={headingStyle}>
                      Stack — base {sections.stack.base} ({sections.stack.layers.length})
                    </h3>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {sections.stack.layers.map((layer) => (
                        <li
                          key={layer.number}
                          style={{ padding: "2px 10px", fontSize: 12, color: muted }}
                        >
                          #{layer.number} {layer.title ?? ""}
                          <span> — {layer.isDraft === true ? "draft" : layer.state}</span>
                        </li>
                      ))}
                    </ul>
                    {((stackMerge !== null && stackMerge.visible) || stackRebase !== null) && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                          padding: "2px 10px",
                        }}
                      >
                        {stackMerge !== null && stackMerge.visible && (
                          <Tooltip
                            host={host}
                            side="top"
                            label={stackMerge.tooltip}
                            showWhenDisabled
                          >
                            <button
                              type="button"
                              disabled={stackMerge.disabled || writeState?.pending === true}
                              ref={stackMergeOpener}
                              onClick={() => openStackConfirm("merge")}
                              style={{ ...control, fontSize: 12, border }}
                            >
                              {stackMerge.label}
                            </button>
                          </Tooltip>
                        )}
                        {stackMerge !== null &&
                          stackMerge.visible &&
                          allowedMergeMethods.length > 1 && (
                            <select
                              aria-label="Merge stack method"
                              value={mergeMethod}
                              disabled={writeState?.pending === true}
                              onChange={(event) => pickMergeMethod(event.target.value)}
                              style={{ ...control, fontSize: 12, padding: "2px 4px" }}
                            >
                              {allowedMergeMethods.map((method) => (
                                <option key={method} value={method}>
                                  {method}
                                </option>
                              ))}
                            </select>
                          )}
                        {stackRebase !== null && (
                          <button
                            type="button"
                            disabled={stackRebase.disabled || writeState?.pending === true}
                            ref={stackRebaseOpener}
                            onClick={() => openStackConfirm("rebase")}
                            style={{ ...control, fontSize: 12, border }}
                          >
                            {stackRebase.label}
                          </button>
                        )}
                        {stackMerge !== null &&
                          stackMerge.visible &&
                          stackMerge.blockedNote !== null && (
                            <span style={{ color: muted, fontSize: 12 }}>
                              {stackMerge.blockedNote}
                            </span>
                          )}
                      </div>
                    )}
                  </section>
                )}

                <section aria-label="Checks" style={{ paddingBottom: 4 }}>
                  <h3 style={headingStyle}>
                    Checks
                    {checksHeading !== null ? ` — ${checksHeading}` : ""}
                  </h3>
                  {detail !== null && detail.checks.length === 0 && (
                    <p style={{ ...noteStyle, fontSize: 12 }}>No checks reported.</p>
                  )}
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {detail?.checks.map((check) => (
                      <CheckRow
                        key={`${check.name}:${check.status}:${check.url ?? ""}`}
                        host={host}
                        check={check}
                      />
                    ))}
                  </ul>
                </section>

                <section aria-label="Linked threads" style={{ paddingBottom: 4 }}>
                  <h3 style={headingStyle}>Linked threads</h3>
                  {ops !== null && ops["prs.linkedThreads"] !== true && (
                    <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                      Linked threads are not supported by this host.
                    </p>
                  )}
                  {sections.linkedError !== null && (
                    <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
                      {sections.linkedError}
                    </p>
                  )}
                  {sections.linked !== null && sections.linked.threads.length === 0 && (
                    <p style={{ ...noteStyle, fontSize: 12 }}>No linked threads.</p>
                  )}
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {sections.linked?.threads.map((thread) => (
                      <li key={thread.id} style={{ padding: "2px 10px", fontSize: 12 }}>
                        {thread.title}
                        <span style={{ color: muted, fontSize: 12 }}>
                          {" "}
                          — {thread.id}
                          {thread.archivedAt !== null ? " · archived" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {sections.linked?.truncated === true && (
                    <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                      Linked-thread list truncated.
                    </p>
                  )}
                </section>

                {ops !== null && ops["prs.activity"] !== true && (
                  <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                    Review threads and comments are not supported by this host (prs.activity).
                  </p>
                )}
                {sections.activityError !== null && (
                  <p role="alert" style={{ ...noteStyle, fontSize: 12 }}>
                    {sections.activityError}
                  </p>
                )}
                {activity !== null && (
                  <>
                    <section aria-label="Review threads" style={{ paddingBottom: 4 }}>
                      <h3 style={headingStyle}>
                        Review threads
                        {activity.reviewThreads.length > 0
                          ? ` (${activity.reviewThreads.length})`
                          : ""}
                      </h3>
                      {activity.reviewThreads.length === 0 && (
                        <p style={{ ...noteStyle, fontSize: 12 }}>No review threads.</p>
                      )}
                      {activity.reviewThreads.map((thread) => {
                        const paged =
                          pagedThreads !== null &&
                          pagedThreads.scope === pagedScope &&
                          pagedThreads.activity === activity
                            ? pagedThreads.map.get(thread.id)
                            : undefined;
                        const merged: PrsReviewThread =
                          paged === undefined
                            ? thread
                            : {
                                ...thread,
                                comments: mergeThreadComments(thread.comments, paged.comments),
                                nextCommentsCursor: paged.nextCursor ?? undefined,
                              };
                        return (
                          <ReviewThreadSection
                            key={thread.id}
                            thread={merged}
                            canPage={ops?.["prs.threadComments"] === true}
                            paging={
                              pagedScope !== null &&
                              pagingThreads.get(`${pagedScope}\n${thread.id}`) === activity
                            }
                            unrecoverable={
                              paged !== undefined
                                ? paged.truncated && paged.nextCursor === null
                                : thread.nextCommentsCursor === undefined &&
                                  thread.commentCount !== undefined &&
                                  thread.commentCount > thread.comments.length
                            }
                            pageError={paged?.error ?? null}
                            onLoadMore={loadThreadComments}
                            write={threadWrite(merged)}
                          />
                        );
                      })}
                    </section>

                    <section aria-label="Comments" style={{ paddingBottom: 4 }}>
                      <h3 style={headingStyle}>
                        Comments{activity.commentCount > 0 ? ` (${activity.commentCount})` : ""}
                      </h3>
                      {activity.comments.length === 0 && (
                        <p style={{ ...noteStyle, fontSize: 12 }}>No comments.</p>
                      )}
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {activity.comments.map((comment) => (
                          <CommentRow key={comment.id} comment={comment} />
                        ))}
                      </ul>
                      {activity.commentsTruncated && (
                        <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                          Comment list truncated by the host.
                        </p>
                      )}
                      {writeOps?.["prs.comment"] === true && (
                        <PrsComposer
                          label="Comment"
                          placeholder="Leave a comment"
                          value={draft("comment")}
                          pending={writePending("comment")}
                          error={writeError("comment")}
                          onChange={(value) => setDraft("comment", value)}
                          onSubmit={(body) =>
                            runWrite(
                              "comment",
                              (signal) =>
                                writeApi().invoke("comment", { ...selected, body }, signal),
                              [{ key: "comment", submitted: body }],
                            )
                          }
                        />
                      )}
                    </section>

                    {write.kind === "ready" &&
                      writeOps?.["prs.submitReview"] === true &&
                      write.verdicts.length > 0 && (
                        <section aria-label="Submit a review" style={{ paddingBottom: 4 }}>
                          <h3 style={headingStyle}>Submit a review</h3>
                          <PrsReviewComposer
                            verdicts={prsWriteVerdictOptions(write.verdicts)}
                            verdict={prsReviewVerdict(
                              draft("review-verdict"),
                              prsWriteVerdictOptions(write.verdicts),
                            )}
                            body={draft("review")}
                            pending={writePending("review")}
                            error={writeError("review")}
                            onVerdictChange={(value) => setDraft("review-verdict", value)}
                            onBodyChange={(value) => setDraft("review", value)}
                            onSubmit={(verdict, body) =>
                              runWrite(
                                "review",
                                (signal) =>
                                  writeApi().invoke(
                                    "submitReview",
                                    { ...selected, verdict, body, comments: [] },
                                    signal,
                                  ),
                                [
                                  { key: "review", submitted: body },
                                  { key: "review-verdict", submitted: verdict },
                                ],
                              )
                            }
                          />
                        </section>
                      )}

                    {activity.commits.length > 0 && (
                      <section aria-label="Commits" style={{ paddingBottom: 4 }}>
                        <h3 style={headingStyle}>Commits ({activity.commits.length})</h3>
                        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                          {activity.commits.map((commit) => {
                            const url = commitUrl(commit.oid);
                            const short = commit.oid.slice(0, 8);
                            return (
                              <li key={commit.oid} style={{ padding: "2px 10px", fontSize: 12 }}>
                                {url === null ? (
                                  <span style={oidStyle}>{short}</span>
                                ) : (
                                  <Tooltip
                                    host={host}
                                    side="top"
                                    label={prsOpenOnHostLabel(detail?.provider ?? "unknown")}
                                  >
                                    <button
                                      type="button"
                                      aria-label={`Open commit ${short} on host`}
                                      onClick={() => openOnHost(url)}
                                      style={{ ...linkButton, ...oidStyle }}
                                    >
                                      {short}
                                    </button>
                                  </Tooltip>
                                )}{" "}
                                {commit.messageHeadline}
                                <span style={{ color: muted, fontSize: 11 }}>
                                  {" "}
                                  · {formatRelativeTime(commit.committedDate)}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}

                    {activity.truncated && (
                      <p role="note" style={{ ...noteStyle, fontSize: 12 }}>
                        Activity truncated — some comments, threads, or commits were not delivered.
                      </p>
                    )}
                  </>
                )}

                <section aria-label="Diff" style={{ paddingBottom: 4 }}>
                  <h3 style={headingStyle}>Diff</h3>
                  <PrsDiffSection
                    key={`${session.context.resource.environmentId ?? ""}:${session.context.resource.projectId ?? ""}:${selected === null ? "" : prsRefKey(selected)}`}
                    diff={diff}
                    supported={ops?.["prs.streamDiff"] === true}
                    onLoadMore={loadMore}
                    host={host}
                    session={session}
                    reference={selected}
                    detail={sections.detail}
                    write={writeOps}
                    viewedReadSupported={ops?.["prs.filesViewed"] === true}
                    revision={revision}
                    onViewedSuccess={() => setViewedFailureKey(null)}
                    onViewedFailure={() => {
                      const disclose = () => setViewedFailureKey(selectedKey);
                      if (
                        !toasts.report(
                          { severity: "error", title: "Could not update viewed files" },
                          disclose,
                        )
                      )
                        disclose();
                    }}
                  />
                  {selectedKey !== null && viewedFailureKey === selectedKey && (
                    <p role="alert" style={noteStyle}>
                      Could not update viewed files
                    </p>
                  )}
                </section>

                {prsWriteUnavailableNote(write) !== null && (
                  <p role="note" style={{ ...noteStyle, fontSize: 12, paddingBottom: 8 }}>
                    {prsWriteUnavailableNote(write)}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {confirming !== null && confirmPlan !== null && (
        <ConfirmDialog
          host={host}
          anchor={confirming.opener}
          title={confirmPlan.confirmTitle}
          description={confirmPlan.confirmDescription}
          confirmLabel={confirmPlan.label}
          pending={stackActionPending}
          onCancel={closeConfirmation}
          onConfirm={runStackAction}
        >
          <ul style={{ listStyle: "none", margin: "4px 0", padding: 0 }}>
            {confirmPlan.layers.map((layer) => (
              <li key={layer.number}>
                #{layer.number} {layer.title ?? layer.headBranch}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </div>
  );
}
