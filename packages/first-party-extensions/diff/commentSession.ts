/**
 * Hook-held state for diff-line comments (parity row D9), lifted out of the
 * view so its lifecycle is testable — the same split as the files pack's
 * commentSession. A diff comment's "buffer" is the delivered source payload
 * plus the file's expansion: selection ordinals and draft payloads are only
 * honest against the exact rows they were captured on, so both are pinned at
 * capture and die the moment any of that moves.
 */

import {
  messagesEnrichmentApi,
  type MessagesEnrichmentCapabilities,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { useEffect, useMemo, useState } from "react";

import {
  buildDiffCommentTarget,
  commentUnavailableReason,
  type DiffCommentTarget,
} from "./diffComments.ts";
import type { DiffDisplayRow } from "./viewModel.ts";

/**
 * The buffer a comment's offsets live against: the delivered source
 * (`diffHash` — value equality proves the bytes did not move), the file
 * (`fileKey`), and the file's loaded expansion (`contents`, compared by
 * value — a reload of identical bytes is not a drift).
 */
export interface CommentBuffer {
  readonly diffHash: string;
  readonly fileKey: string;
  readonly contents: { readonly oldContents: string; readonly newContents: string } | null;
}

function sameCommentBuffer(left: CommentBuffer, right: CommentBuffer): boolean {
  return (
    left.diffHash === right.diffHash &&
    left.fileKey === right.fileKey &&
    (left.contents === right.contents ||
      (left.contents !== null &&
        right.contents !== null &&
        left.contents.oldContents === right.contents.oldContents &&
        left.contents.newContents === right.contents.newContents))
  );
}

/**
 * The selected run of diff rows. A run is a pair of row ordinals into one
 * file's row list, captured pinned to the buffer they were made in and dead
 * the moment any of it moves — a refresh that changes the diff, an
 * expansion load that reshapes the rows, leaving the file. A byte-identical
 * redelivery keeps the pin: `diffHash` equality proves the rows the
 * ordinals address are the same rows. Without the pin, a refresh under a
 * held selection re-arms ordinals over rows that drifted underneath them.
 */
export function useLineSelection(buffer: CommentBuffer | null): {
  readonly selection: { readonly anchor: number; readonly extent: number } | null;
  readonly select: (buffer: CommentBuffer, ordinal: number, extend: boolean) => void;
  readonly clear: () => void;
} {
  const [pinned, setPinned] = useState<{
    readonly buffer: CommentBuffer;
    readonly anchor: number;
    readonly extent: number;
  } | null>(null);
  const live =
    pinned !== null && buffer !== null && sameCommentBuffer(pinned.buffer, buffer) ? pinned : null;
  if (pinned !== null && live === null) {
    // Retire in render (React's adjust-state-when-props-change shape) on ANY
    // mismatch: a lingering pin would re-match when a file or source is
    // revisited and re-arm ordinals nobody is holding. The pin is already
    // dead at read, so retiring there is free.
    setPinned(null);
  }
  return {
    selection: live === null ? null : { anchor: live.anchor, extent: live.extent },
    // The buffer is passed at call time, not captured from this render: a
    // click in a different file pins that file's buffer, never the previous
    // file's via a stale closure. Extending keeps the anchor only when the
    // held run lives in the same buffer.
    select: (buffer, ordinal, extend) => {
      setPinned(
        extend && live !== null && sameCommentBuffer(live.buffer, buffer)
          ? { buffer, anchor: live.anchor, extent: ordinal }
          : { buffer, anchor: ordinal, extent: ordinal },
      );
    },
    clear: () => setPinned(null),
  };
}

/** The open comment draft — the built target captured against one buffer. */
export interface DiffCommentDraft {
  readonly fileKey: string;
  readonly filePath: string;
  readonly target: DiffCommentTarget;
}

/**
 * The comment draft pinned to the buffer its selection and quote were
 * captured against — the same pin-at-capture shape as the selection above,
 * one level deeper at the write path. The rows stay live under an open
 * draft (a refresh or an expansion load can land any time), so the captured
 * anchor is only honest while the buffer is byte-identical: a drift turns
 * the form stale (`draftStale`) rather than letting submit ship a quote
 * captured against different rows — `attachAnnotation` must never receive
 * an anchor for lines the live diff no longer shows where the draft says.
 * And a draft dies with navigation the way a selection does: leaving the
 * file retires the pin in render, so returning to it cannot re-arm a draft
 * over rows that may have changed in between.
 */
export function useDiffCommentDraft(buffer: CommentBuffer | null): {
  readonly draft: DiffCommentDraft | null;
  readonly draftStale: boolean;
  readonly openDraft: (buffer: CommentBuffer, draft: DiffCommentDraft) => void;
  readonly closeDraft: () => void;
} {
  const [pinned, setPinned] = useState<{
    readonly buffer: CommentBuffer;
    readonly draft: DiffCommentDraft;
  } | null>(null);
  const sameFile = pinned !== null && buffer !== null && pinned.buffer.fileKey === buffer.fileKey;
  if (pinned !== null && !sameFile) setPinned(null);
  const draft = sameFile && pinned !== null ? pinned.draft : null;
  // Stale stays visible: the form keeps the user's text and names the drift,
  // but submit is dead while the pinned buffer no longer matches.
  const draftStale =
    draft !== null &&
    buffer !== null &&
    pinned !== null &&
    !sameCommentBuffer(pinned.buffer, buffer);
  return {
    draft,
    draftStale,
    // Buffer at call time, same rule as the selection's `select`: the draft
    // pins the exact buffer its target was built against.
    openDraft: (buffer, draft) => setPinned({ buffer, draft }),
    closeDraft: () => setPinned(null),
  };
}

/**
 * The built target for the live selection — memoized so unrelated renders
 * (theme ticks, wrap flips, selections in other chrome) never re-enumerate
 * the file's review rows. A held reference across re-renders is the
 * observable proof the memo held; a new anchor or extent legitimately
 * recomputes.
 */
export function useCommentTarget(
  file: FileDiffMetadata,
  rows: readonly DiffDisplayRow[],
  anchor: number | null,
  extent: number | null,
): DiffCommentTarget | null {
  return useMemo(
    () =>
      anchor === null || extent === null
        ? null
        : buildDiffCommentTarget({ file, rows, startOrdinal: anchor, endOrdinal: extent }),
    [file, rows, anchor, extent],
  );
}

/** The grant-free `t3.messages/enrichment` capability probe, as the panel consumes it. */
const CHECKING_REASON = "Checking comment support with the host…";

/**
 * Why commenting is unavailable right now, or null when a selection can be
 * submitted, plus the capabilities themselves (the listing gate reads
 `listAnnotations` off them). The probe itself is grant-free; a denied write
 * grant can only surface as the invoke's named error at submit, which the
 * form shows inline. A rejected probe is a degraded capability answer in the
 * host's own `transport: "unavailable"` vocabulary — never a "Checking…"
 * state that outlives the probe that died.
 */
export function useCommentBlockReason(
  host: ClientHost,
  session: ViewSession,
  threadId: string | undefined,
): {
  readonly reason: string | null;
  readonly capabilities: MessagesEnrichmentCapabilities | null;
} {
  const [capabilities, setCapabilities] = useState<MessagesEnrichmentCapabilities | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(messagesEnrichmentApi, host, session.context)
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
                : "Comment support could not be checked with the host.",
            operations: {
              attachAnnotation: false,
              listAnnotations: false,
              removeAnnotation: false,
            },
          });
        },
      );
    return () => controller.abort();
  }, [host, session]);
  // threadId is read per render, not captured in the effect: a thread-scoped
  // surface can switch threads under a mounted panel.
  return {
    reason:
      capabilities === null ? CHECKING_REASON : commentUnavailableReason(capabilities, threadId),
    capabilities,
  };
}

/** One comment the panel posted or listed, keyed by its host-minted id. */
export interface PostedComment {
  readonly annotationId: string;
  readonly filePath: string;
  /** Captured on post; listed entries match by path instead. */
  readonly fileKey: string | null;
  readonly rangeLabel: string;
  /** The writer's words; listed entries carry none (the contract lists ids only). */
  readonly text: string | null;
  readonly sectionTitle: string | null;
}

/**
 * The panel's own view of the thread's unsent diff comments: posted entries
 * plus a one-shot `listAnnotations` read (own installation's ids only), so
 * comments from before this panel mounted are still visible and removable.
 * Removal runs through `removeAnnotation` — the reverse of the post, the
 * way out the files pack's contract never had.
 */
export function usePostedComments(
  host: ClientHost,
  session: ViewSession,
  threadId: string | undefined,
  listable: boolean,
): {
  readonly entries: readonly PostedComment[];
  readonly listError: string | null;
  readonly removing: string | null;
  readonly removeError: string | null;
  readonly post: (entry: PostedComment) => void;
  readonly remove: (annotationId: string) => void;
} {
  const [entries, setEntries] = useState<readonly PostedComment[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    if (!listable || threadId === undefined) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(messagesEnrichmentApi, host, session.context)
      .invoke("listAnnotations", { threadId }, signal)
      .then(
        (result) => {
          if (signal.aborted) return;
          setEntries((previous) => {
            const known = new Set(previous.map((entry) => entry.annotationId));
            const listed = result.annotations
              .filter(
                (annotation) => annotation.kind === "diff" && !known.has(annotation.annotationId),
              )
              .map((annotation) => ({
                annotationId: annotation.annotationId,
                filePath: annotation.filePath,
                fileKey: null,
                rangeLabel: annotation.rangeLabel,
                text: null,
                sectionTitle: annotation.sectionTitle,
              }));
            return [...previous, ...listed];
          });
        },
        (error) => {
          if (!signal.aborted)
            setListError(
              error instanceof Error ? error.message : "Earlier comments could not be listed.",
            );
        },
      );
    return () => controller.abort();
  }, [host, session, threadId, listable]);

  return {
    entries,
    listError,
    removing,
    removeError,
    post: (entry) =>
      setEntries((previous) =>
        previous.some((existing) => existing.annotationId === entry.annotationId)
          ? previous
          : [...previous, entry],
      ),
    remove: (annotationId) => {
      if (removing !== null || threadId === undefined) return;
      setRemoving(annotationId);
      setRemoveError(null);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, session.signal]);
      void bindApi(messagesEnrichmentApi, host, session.context)
        .invoke("removeAnnotation", { threadId, annotationId }, signal)
        .then(
          (result) => {
            if (signal.aborted) return;
            // removed:false is the already-gone case — drop it locally either
            // way; the host's own-ids rule keeps other installations' comments
            // out of reach, and their removal lands as the named error below.
            setEntries((previous) =>
              previous.filter((entry) => entry.annotationId !== annotationId),
            );
            if (!result.removed) setRemoveError("The host no longer lists that comment.");
            setRemoving(null);
          },
          (error) => {
            if (signal.aborted) return;
            setRemoveError(
              error instanceof Error ? error.message : "The comment could not be removed.",
            );
            setRemoving(null);
          },
        );
    },
  };
}
