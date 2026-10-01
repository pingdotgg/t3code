/**
 * Per-project URL history over the public `t3.browser/history` contract —
 * the same list the native preview keeps per project, so a visit in one
 * thread is a recent in every thread of the project and outlives the thread.
 *
 * The view's own `session.save` list (`historyStore.ts`) stays the fallback:
 * until the project list arrives, and whenever the contract cannot serve it,
 * the panel shows its own rows. A failure is a named state, never a spinner.
 */
import { describeGrantDenial, grantDenialMessage } from "@t3tools/extension-sdk/capabilities";
import {
  BROWSER_READ_HISTORY,
  BROWSER_RECORD_HISTORY,
  type BrowserHistoryList,
} from "@t3tools/extension-sdk/catalogue";

import { type BrowserHistoryEntry, sanitizeHistoryEntries } from "./historyStore.ts";

export type ProjectHistoryState =
  /** No project list yet — the view shows its own rows, without a spinner. */
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly entries: readonly BrowserHistoryEntry[];
      /** The host kept only the most recent entries that fit its answer budget. */
      readonly truncated: boolean;
    }
  /** The contract cannot serve this view; its own rows stand in, and say so. */
  | { readonly kind: "unavailable"; readonly message: string };

type HistoryOp = "list" | "record" | "setTitle" | "remove";

/** The structural shape `bindApi(browserHistoryApi, …)` returns — tests inject a fake. */
export interface ProjectHistoryApi {
  invoke(
    method: "list",
    input: Record<string, never>,
    signal: AbortSignal,
  ): Promise<BrowserHistoryList>;
  invoke(
    method: "record" | "remove",
    input: { url: string },
    signal: AbortSignal,
  ): Promise<BrowserHistoryList>;
  invoke(
    method: "setTitle",
    input: { url: string; title: string },
    signal: AbortSignal,
  ): Promise<BrowserHistoryList>;
}

/**
 * A failed op → named state. A missing grant names the permission to grant;
 * a host with no connected history provider (or any other failure) is
 * reported with its detail.
 */
export function projectHistoryErrorState(
  op: HistoryOp,
  error: unknown,
): Extract<ProjectHistoryState, { readonly kind: "unavailable" }> {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("capability denied")) {
    // Reads need the read grant; writes need both, and the broker names the first missing.
    const grant =
      describeGrantDenial(error)?.grant ??
      (op === "list" ? BROWSER_READ_HISTORY : BROWSER_RECORD_HISTORY);
    return {
      kind: "unavailable",
      message: `Showing this view's history only — ${grantDenialMessage(grant)}`,
    };
  }
  return {
    kind: "unavailable",
    message: `Showing this view's history only — project history is unavailable${text ? ` (${text.slice(0, 300)})` : ""}.`,
  };
}

/**
 * The rows the recents list renders: the project list once it has arrived,
 * otherwise the view's own list.
 */
export function displayedHistory(
  state: ProjectHistoryState,
  own: readonly BrowserHistoryEntry[],
): readonly BrowserHistoryEntry[] {
  return state.kind === "ready" ? state.entries : own;
}

/**
 * Issues history ops for one view. Every op answers with the whole list, so
 * the latest-issued answer is the truth: an older answer that lands late is
 * dropped, and nothing is reported after `signal` aborts.
 */
export function createProjectHistory(
  api: ProjectHistoryApi,
  signal: AbortSignal,
  onState: (state: ProjectHistoryState) => void,
) {
  let issued = 0;
  const run = (op: HistoryOp, request: (signal: AbortSignal) => Promise<BrowserHistoryList>) => {
    const sequence = ++issued;
    const current = () => !signal.aborted && sequence === issued;
    void request(signal).then(
      (result) => {
        if (current())
          onState({
            kind: "ready",
            entries: sanitizeHistoryEntries(result?.entries),
            truncated: result?.truncated === true,
          });
      },
      (error) => {
        if (current()) onState(projectHistoryErrorState(op, error));
      },
    );
  };
  return {
    refresh: () => run("list", (abort) => api.invoke("list", {}, abort)),
    record: (url: string) => run("record", (abort) => api.invoke("record", { url }, abort)),
    setTitle: (url: string, title: string) =>
      run("setTitle", (abort) => api.invoke("setTitle", { url, title }, abort)),
    remove: (url: string) => run("remove", (abort) => api.invoke("remove", { url }, abort)),
  };
}

export type ProjectHistory = ReturnType<typeof createProjectHistory>;

/**
 * The receipt fence. Revisions count per server epoch, so the fence is the
 * pair: an epoch it has not seen is a restarted server and never stale, and
 * accepting it moves both halves; within an epoch revisions only go forward;
 * an epoch the fence has moved past stays stale for good.
 */
export type RevisionFence = {
  epoch: string | null;
  revision: number;
  readonly retired: Set<string>;
};

export function createRevisionFence(): RevisionFence {
  return { epoch: null, revision: -1, retired: new Set() };
}

export function isStaleRevision(fence: RevisionFence, epoch: string, revision: number): boolean {
  return fence.retired.has(epoch) || (epoch === fence.epoch && revision < fence.revision);
}

/** Moves the fence to `(epoch, revision)` unless that is stale; returns whether it moved. */
export function advanceRevision(fence: RevisionFence, epoch: string, revision: number): boolean {
  if (isStaleRevision(fence, epoch, revision)) return false;
  if (fence.epoch !== null && fence.epoch !== epoch) fence.retired.add(fence.epoch);
  fence.epoch = epoch;
  fence.revision = revision;
  return true;
}

/**
 * The view's `dispatch`: runs one engine command and settles its receipt. The
 * events stream may already have applied a newer revision, so the receipt's
 * snapshot is adopted (or its refusal shown) only when `fence` admits it.
 * The accepted command's own side effect — recording the visit — belongs to
 * the command, not the snapshot, so it runs exactly once whenever the command
 * was accepted. Nothing settles after `signal` aborts.
 */
export function createCommandDispatch<
  Receipt extends {
    readonly revision: number;
    readonly outcome: string;
    readonly serverEpoch: string;
  },
>(options: {
  readonly signal: AbortSignal;
  readonly fence: RevisionFence;
  readonly adopt: (receipt: Receipt) => void;
  readonly refuse: (outcome: string) => void;
  readonly fail: (error: unknown) => void;
}) {
  const { signal, fence } = options;
  return (run: (signal: AbortSignal) => Promise<Receipt>, onAccepted?: () => void): void => {
    void run(signal).then(
      (receipt) => {
        if (signal.aborted) return;
        const current = advanceRevision(fence, receipt.serverEpoch, receipt.revision);
        if (receipt.outcome !== "accepted") {
          if (current) options.refuse(receipt.outcome);
          return;
        }
        if (current) options.adopt(receipt);
        onAccepted?.();
      },
      (error) => {
        if (!signal.aborted) options.fail(error);
      },
    );
  };
}

/**
 * The page title native writes back once a recorded page loads: only a
 * loaded page with a title, never a workspace-file presentation. Returns the
 * `url`/`title` pair to send, or null.
 */
export function titleUpdate(
  navigation: { readonly kind: string; readonly url: string | null; readonly title: string } | null,
  presentingFile: boolean,
  isLeaseUrl: (url: string) => boolean,
): { readonly url: string; readonly title: string } | null {
  if (!navigation || navigation.kind !== "loaded" || presentingFile) return null;
  const { url, title } = navigation;
  if (!url || !title.trim() || isLeaseUrl(url)) return null;
  return { url, title };
}
