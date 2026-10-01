/**
 * Consumer side of `t3.workspace/changes` — the hooks that turn the host's
 * per-thread mutation counter into panel refreshes. The stream is the
 * orchestration signal (completed command_execution / file_change items),
 * not a filesystem watcher: edits made outside the agent never arrive here
 * and stay manual-refresh only, matching the native panel. A folded stream
 * loses nothing across a close — every resubscribe opens with a snapshot
 * carrying the latest seq, so `closed:overflow` just reconnects.
 */

import { workspaceChangesApi } from "@t3tools/extension-sdk/catalogue";
import { bindStreamApi, resolveResumableStreams } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useRef, useState } from "react";

import { shouldHandleMutation } from "./viewModel.ts";

const CHANGES_RETRY_MS = 250;
const CHANGES_ERROR_RETRY_MS = 1000;

/**
 * Stream health for the status line: `idle` (hidden or threadless),
 * `connecting` (first frame not yet delivered), `live` (frames flowing),
 * `degraded` (a subscription attempt failed or ended without frames — the
 * panel keeps retrying, but manual refresh is the only working path until
 * the stream recovers), `offline` (the host is waiting for the environment's
 * connection; only on hosts that resume this stream).
 */
export type WorkspaceChangesStatus = "idle" | "connecting" | "live" | "degraded" | "offline";

export function useWorkspaceChanges(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  options?: { readonly retryMs?: number; readonly errorRetryMs?: number },
): {
  readonly mutationSeq: number | null;
  readonly status: WorkspaceChangesStatus;
  /** Counts the connections that came back after `offline`: each one is a cue to reload. */
  readonly resumed: number;
} {
  const [mutationSeq, setMutationSeq] = useState<number | null>(null);
  const [streamStatus, setStreamStatus] =
    useState<Exclude<WorkspaceChangesStatus, "idle">>("connecting");
  const [resumed, setResumed] = useState(0);
  // Outlives a resubscribe: a view hidden while offline still owes its reload.
  const suspendedRef = useRef(false);
  const threadId = session.context.resource.threadId;
  const retryMs = options?.retryMs ?? CHANGES_RETRY_MS;
  const errorRetryMs = options?.errorRetryMs ?? CHANGES_ERROR_RETRY_MS;
  const active = visible && typeof threadId === "string" && threadId.length > 0;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const delay = (ms: number) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    // A host that resumes this stream follows the environment's connection:
    // it reports each wait for one, and the snapshot that ends it proves the
    // connection is back.
    const resumable = resolveResumableStreams(host, "t3.workspace/changes#subscribeChanges");
    const onSuspended = () => {
      if (signal.aborted) return;
      suspendedRef.current = true;
      setStreamStatus("offline");
    };
    void (async () => {
      while (!signal.aborted) {
        let retry = retryMs;
        try {
          const stream = bindStreamApi(workspaceChangesApi, host, session.context).subscribe(
            "subscribeChanges",
            { threadId },
            signal,
            resumable ? { resume: "fresh-snapshot", onSuspended } : undefined,
          );
          for await (const frame of stream) {
            if (frame.value.kind === "closed") break;
            if (suspendedRef.current) {
              suspendedRef.current = false;
              setResumed((value) => value + 1);
            }
            setStreamStatus("live");
            setMutationSeq(frame.value.mutationSeq);
          }
        } catch {
          if (signal.aborted) return;
          retry = errorRetryMs;
        }
        // Any non-aborted end or failure — including one after delivered
        // frames — means updates are not flowing. Degraded holds through the
        // retry attempt too: only a fresh frame re-establishes live.
        if (!signal.aborted) setStreamStatus("degraded");
        await delay(retry);
      }
    })();
    return () => controller.abort();
  }, [host, session, active, threadId, retryMs, errorRetryMs]);
  return { mutationSeq, status: active ? streamStatus : "idle", resumed };
}

/**
 * Every newly observed nonzero seq triggers one refresh, gated on `enabled`
 * so a latched save keeps the bump pending until it opens. The first
 * observed seq fires too — it can fold mutations that landed while the
 * view's initial reads were in flight; suppressing it left stale bytes
 * displayed indefinitely. A seq that arrives with a resumed connection
 * (`resumed` from useWorkspaceChanges) is absorbed: the reconnect reload
 * already covers it, and a second refresh would re-request the tree.
 */
export function useMutationRefresh(input: {
  readonly mutationSeq: number | null;
  readonly enabled: boolean;
  readonly refresh: () => void;
  readonly resumed?: number;
}): void {
  const handledRef = useRef<number | null>(null);
  const resumedRef = useRef(input.resumed ?? 0);
  const { mutationSeq, enabled, refresh, resumed = 0 } = input;
  useEffect(() => {
    if (resumed !== resumedRef.current) {
      resumedRef.current = resumed;
      handledRef.current = mutationSeq;
      return;
    }
    if (mutationSeq === null) return;
    if (!shouldHandleMutation({ enabled, mutationSeq, handledSeq: handledRef.current })) return;
    handledRef.current = mutationSeq;
    refresh();
  }, [enabled, mutationSeq, refresh, resumed]);
}
