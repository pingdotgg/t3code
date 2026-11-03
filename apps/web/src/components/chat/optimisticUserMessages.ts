import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { SetStateAction } from "react";
import type { ChatMessage } from "../../types";
import { collectUserMessageBlobPreviewUrls } from "../ChatView.logic";

/**
 * Messages shown before the server echoes them. An acknowledged message leaves `messages` in the
 * render its ack arrives, so it never reappears even if the server later drops its row. Its blob
 * previews stay in `handoff` until the server's copies load (see useAttachmentPreviewHandoff).
 */
export interface OptimisticUserMessages {
  readonly threadId: ThreadId;
  readonly messages: ChatMessage[];
  readonly handoff: Readonly<Record<string, ReadonlyArray<string>>>;
}

export function emptyOptimisticUserMessages(threadId: ThreadId): OptimisticUserMessages {
  return { threadId, messages: [], handoff: {} };
}

/**
 * The view's state for `threadId`: the previous thread's messages are released when the thread
 * changes, and acknowledged messages are moved out of `messages`. Returns `state` when nothing changes.
 */
export function reconcileOptimisticUserMessages(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  acknowledgedIds: ReadonlySet<MessageId>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return emptyOptimisticUserMessages(threadId);
  if (!state.messages.some((message) => acknowledgedIds.has(message.id))) return state;
  const messages: ChatMessage[] = [];
  const handoff: Record<string, ReadonlyArray<string>> = { ...state.handoff };
  for (const message of state.messages) {
    if (!acknowledgedIds.has(message.id)) {
      messages.push(message);
      continue;
    }
    const previewUrls = collectUserMessageBlobPreviewUrls(message);
    if (previewUrls.length > 0) handoff[message.id] = previewUrls;
  }
  return { ...state, messages, handoff };
}

/** Applies a send-path update. An update for a thread the view has since left is dropped. */
export function applyOptimisticUserMessagesAction(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  action: SetStateAction<ChatMessage[]>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return state;
  const next = typeof action === "function" ? action(state.messages) : action;
  const unchanged =
    next.length === state.messages.length &&
    next.every((message, index) => message === state.messages[index]);
  return unchanged ? state : { ...state, messages: next };
}

export function dropOptimisticHandoff(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  messageId: MessageId,
): OptimisticUserMessages {
  if (state.threadId !== threadId || !(messageId in state.handoff)) return state;
  const { [messageId]: _released, ...handoff } = state.handoff;
  return { ...state, handoff };
}

/**
 * Blob previews a chat view owns per thread. Revocation cannot run in a state updater, so handlers
 * revoke here and leaving the thread revokes the rest. A handed-off preview still stands in for the
 * server's row, so releasing its message (a send failing after the ack) leaves it to the handoff.
 */
export interface OptimisticBlobPreviews {
  readonly track: (threadId: ThreadId, message: ChatMessage) => void;
  readonly handOff: (state: OptimisticUserMessages) => void;
  readonly revoke: (threadId: ThreadId, previewUrls: ReadonlyArray<string>) => void;
  readonly release: (threadId: ThreadId, message: ChatMessage) => void;
  readonly revokeThread: (threadId: ThreadId) => void;
}

export function createOptimisticBlobPreviews(): OptimisticBlobPreviews {
  const ownedByThread = new Map<ThreadId, Set<string>>();
  const handedOff = new Set<string>();
  const revoke = (threadId: ThreadId, previewUrls: ReadonlyArray<string>) => {
    const owned = ownedByThread.get(threadId);
    for (const previewUrl of previewUrls) {
      owned?.delete(previewUrl);
      handedOff.delete(previewUrl);
      if (typeof URL !== "undefined") URL.revokeObjectURL(previewUrl);
    }
  };
  return {
    track: (threadId, message) => {
      const previewUrls = collectUserMessageBlobPreviewUrls(message);
      if (previewUrls.length === 0) return;
      const owned = ownedByThread.get(threadId) ?? new Set<string>();
      for (const previewUrl of previewUrls) owned.add(previewUrl);
      ownedByThread.set(threadId, owned);
    },
    handOff: (state) => {
      for (const previewUrls of Object.values(state.handoff)) {
        for (const previewUrl of previewUrls) handedOff.add(previewUrl);
      }
    },
    revoke,
    release: (threadId, message) =>
      revoke(
        threadId,
        collectUserMessageBlobPreviewUrls(message).filter((url) => !handedOff.has(url)),
      ),
    revokeThread: (threadId) => {
      revoke(threadId, [...(ownedByThread.get(threadId) ?? [])]);
      ownedByThread.delete(threadId);
    },
  };
}

// Server asset URLs carry a signed token, so the error keeps only where the image was loaded from.
class ImagePreloadError extends Schema.TaggedError<ImagePreloadError>()("ImagePreloadError", {
  protocol: Schema.String,
  host: Schema.String,
}) {
  static fromUrl(url: string) {
    const parsed = URL.parse(url, globalThis.location?.href);
    return new ImagePreloadError({ protocol: parsed?.protocol ?? "", host: parsed?.host ?? "" });
  }
}

const preloadImage = Effect.fn("optimisticUserMessages.preloadImage")(function* (url: string) {
  yield* Effect.callback<void, ImagePreloadError>((resume) => {
    const image = new Image();
    image.addEventListener("load", () => resume(Effect.void), { once: true });
    image.addEventListener("error", () => resume(Effect.fail(ImagePreloadError.fromUrl(url))), {
      once: true,
    });
    image.src = url;
    return Effect.sync(() => {
      image.src = "";
    });
  });
});

/**
 * Loads one handoff's server previews, keyed by `[serverUrls, blobUrls]`. Once they have all
 * loaded the blobs are no longer shown, so they are revoked here, once per load. A failed load
 * keeps the handoff, and its blobs, until the thread is left.
 */
const handoffPreloadAtom = Atom.family((key: string) => {
  const [serverUrls, blobUrls] = JSON.parse(key) as [string[], string[]];
  return Atom.make(
    typeof Image === "undefined"
      ? Effect.never
      : Effect.forEach(serverUrls, preloadImage, { concurrency: "unbounded", discard: true }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
            }),
          ),
        ),
  );
});

/**
 * The message ids, among `[messageId, serverUrls, blobUrls]` entries, whose server previews have
 * loaded. Each handoff preloads in its own atom, so a change to the set does not restart the rest.
 */
export const loadedHandoffMessageIdsAtom = Atom.family((key: string) => {
  const preloads = JSON.parse(key) as Array<[MessageId, string[], string[]]>;
  return Atom.make((get) =>
    preloads.flatMap(([messageId, serverUrls, blobUrls]) =>
      AsyncResult.isSuccess(get(handoffPreloadAtom(JSON.stringify([serverUrls, blobUrls]))))
        ? [messageId]
        : [],
    ),
  );
});
