/**
 * Add-to-chat through the composer draft bridge (parity row 13). The native
 * panel's "Add to chat" appends a serialized file mention to the thread's
 * draft; `t3.composer/context@1.1.0` `insertMention` is that append,
 * byte-exact, routed through the host. The panel has no composer of its own
 * — the mention lands in whatever client hosts the draft for the thread this
 * view is scoped to.
 */

import { composerContextApi, type ComposerCapabilities } from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useState } from "react";

export interface MentionTransportCapabilities {
  readonly transport: string;
  readonly detail: string | null;
  readonly operations: { readonly insertMention?: boolean };
}

/**
 * Why Add to chat is unavailable, or null when a mention can run. The draft
 * store is client-local, so only a client transport can take the insert, and
 * only when it reports the 1.1.0 op; a missing thread scope means this panel
 * has no chat to add to. Grant denial is not knowable here — the write
 * surfaces as the invoke's named error, shown inline at the click site.
 */
export function mentionUnavailableReason(
  capabilities: MentionTransportCapabilities,
  threadId: string | undefined,
): string | null {
  if (threadId === undefined)
    return "This panel has no thread scope, so there is no chat to add to.";
  if (capabilities.transport !== "client" || capabilities.operations.insertMention !== true) {
    return (
      capabilities.detail ?? "Add to chat needs a connected client hosting the composer provider."
    );
  }
  return null;
}

/** One Add-to-chat click's outcome, pinned to the path it was started for. */
export type AddToChatState =
  | { readonly kind: "idle" }
  | { readonly kind: "adding"; readonly path: string }
  | { readonly kind: "added"; readonly path: string; readonly inserted: number }
  | { readonly kind: "failed"; readonly path: string; readonly message: string };

/** Grant-free `t3.composer/context` capability probe, as the toolbar consumes it. */
const CHECKING_REASON = "Checking chat support with the host…";

/**
 * The Add-to-chat affordance's state: why it is blocked (null when it can
 * run), the latest click's outcome, and the action itself. The probe mirrors
 * `useCommentBlockReason` — grant-free, degraded answers in the host's own
 * `transport: "unavailable"` vocabulary, never a "Checking…" state that
 * outlives the probe that died.
 */
export function useAddToChat(
  host: ClientHost,
  session: ViewSession,
  threadId: string | undefined,
): {
  readonly blockReason: string | null;
  readonly state: AddToChatState;
  readonly addToChat: (path: string) => void;
} {
  const [capabilities, setCapabilities] = useState<ComposerCapabilities | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(composerContextApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (resolved) => {
          if (!signal.aborted) setCapabilities(resolved);
        },
        (error) => {
          if (signal.aborted) return;
          setCapabilities({
            adapter: "unknown",
            transport: "unavailable",
            detail:
              error instanceof Error
                ? error.message
                : "Chat support could not be checked with the host.",
            operations: {
              insertContext: false,
              getDraftState: false,
              insertMention: false,
              insertTerminalContext: false,
            },
          });
        },
      );
    return () => controller.abort();
  }, [host, session]);
  // threadId is read per render, not captured in the effect: a project-scoped
  // surface can switch threads under a mounted panel.
  const blockReason =
    capabilities === null ? CHECKING_REASON : mentionUnavailableReason(capabilities, threadId);

  const [state, setState] = useState<AddToChatState>({ kind: "idle" });
  const addToChat = (path: string) => {
    // The probe only gates the affordance; the invoke's authority is the live
    // grant. A click while one is in flight is ignored.
    if (blockReason !== null || threadId === undefined || state.kind === "adding") return;
    setState({ kind: "adding", path });
    void bindApi(composerContextApi, host, session.context)
      .invoke("insertMention", { threadId, paths: [path] }, session.signal)
      .then(
        (result) => setState({ kind: "added", path, inserted: result.inserted }),
        (error) =>
          setState({
            kind: "failed",
            path,
            message: error instanceof Error ? error.message : "The file could not be added to chat",
          }),
      );
  };
  return { blockReason, state, addToChat };
}
