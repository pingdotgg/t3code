import { workspaceTreeApi, type WorkspaceTreeEvent } from "@t3tools/extension-sdk/catalogue";
import { bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useState } from "react";

import type { WorkspaceChangesStatus } from "./mutationRefresh.ts";
import type { TreeEntry } from "./viewModel.ts";

const emptyEntries: readonly TreeEntry[] = [];

/** The disconnected status line on hosts that do not expose the environment's label. */
export const TREE_DISCONNECTED_STATUS = "Environment is not connected.";

/** Native's disconnected wording, "<label> is not connected.", when the host knows the label. */
export function treeDisconnectedStatus(host: ClientHost): string {
  const label = host.environmentLabel?.();
  return label ? `${label} is not connected.` : TREE_DISCONNECTED_STATUS;
}

/**
 * Finite `t3.workspace/tree` snapshot consumed to completion, then swapped in.
 * `connection` is the workspace changes stream's view of the environment's
 * connection: while it is `offline` no snapshot is requested (the last known
 * entries stay, like native's tree), and each resumed connection reloads.
 */
export function useWorkspaceTree(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
  connection: { readonly status: WorkspaceChangesStatus; readonly resumed: number },
) {
  const [snapshot, setSnapshot] = useState<{
    entries: readonly TreeEntry[];
    status: string;
    revision: number;
    truncated: boolean;
  } | null>(null);
  const [manualRefresh, setRefresh] = useState(0);
  const refresh = manualRefresh + connection.resumed;
  const offline = connection.status === "offline";
  useEffect(() => {
    if (!visible || offline) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      try {
        const next: TreeEntry[] = [];
        let completed = false;
        let truncated = false;
        const stream = bindStreamApi(workspaceTreeApi, host, session.context).subscribe(
          "snapshot",
          {},
          signal,
        );
        for await (const frame of stream) {
          signal.throwIfAborted();
          const event: WorkspaceTreeEvent = frame.value;
          if (event.kind === "chunk") {
            if (event.entries.length > 200)
              throw new Error("Workspace tree chunk exceeded 200 entries.");
            next.push(...event.entries);
            if (next.length > 25000)
              throw new Error("Workspace tree exceeded the 25,000-entry limit.");
            truncated = truncated || event.truncated;
          } else if (event.kind === "complete") {
            if (event.entryCount !== next.length)
              throw new Error("Workspace tree snapshot count was inconsistent.");
            truncated = truncated || event.truncated;
            completed = true;
            break;
          } else throw new Error("Workspace tree returned an unknown snapshot event.");
        }
        if (!completed) throw new Error("Workspace tree snapshot ended before completion.");
        setSnapshot({
          entries: next,
          revision: refresh,
          truncated,
          status: truncated ? "Files ready (index truncated)" : "Files ready",
        });
      } catch (error) {
        if (!signal.aborted)
          setSnapshot((previous) => ({
            entries: previous?.entries ?? emptyEntries,
            revision: refresh,
            truncated: previous?.truncated ?? false,
            status: error instanceof Error ? error.message : "Workspace tree unavailable",
          }));
      }
    })();
    return () => controller.abort();
  }, [host, refresh, session, visible, offline]);
  return {
    entries: snapshot?.entries ?? emptyEntries,
    status: offline
      ? treeDisconnectedStatus(host)
      : snapshot?.revision === refresh
        ? snapshot.status
        : "Loading files",
    truncated: snapshot?.revision === refresh ? snapshot.truncated : false,
    revision: refresh,
    pending: !offline && snapshot?.revision !== refresh,
    refresh: () => setRefresh((value) => value + 1),
  };
}
