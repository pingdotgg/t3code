import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
} from "@t3tools/client-runtime/state/command-output";
import {
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_ITEM_ROUTE,
  GUEST_SHARE_PARAM,
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2GetTurnItemResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { TurnItemSource } from "../chat/timelineRowContext";

/** What an expanded guest row says when it cannot read the item. */
class GuestItemReadError extends Data.TaggedError("GuestItemReadError")<{
  readonly message: string;
}> {}

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));
const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);

const itemUrl = (route: string, shareId: string, itemId: string) =>
  `${route}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&item=${encodeURIComponent(itemId)}`;

/** `item` is null when the thread no longer has the item, or the share ended. */
async function fetchGuestItemDetail(
  shareId: string,
  itemId: string,
): Promise<OrchestrationV2GetTurnItemResult> {
  const response = await fetch(itemUrl(GUEST_ITEM_ROUTE, shareId, itemId));
  if (response.status === 403) return { item: null };
  if (!response.ok) throw new Error(`Guest item request failed with ${response.status}.`);
  return decodeDetail(await response.json());
}

// Keys are JSON so a share id or item id can never run into the next part.
const guestItemDetailAtom = Atom.family((key: string) => {
  const [shareId, itemId] = JSON.parse(key) as [string, string, string];
  return Atom.make(
    Effect.tryPromise({
      try: () => fetchGuestItemDetail(shareId, itemId),
      catch: () => new GuestItemReadError({ message: "Could not load this item." }),
    }),
  );
});

/** Ends after the frame of a settled command, so the browser does not reconnect to it. */
const guestCommandOutputAtom = Atom.family((key: string) => {
  const [shareId, itemId] = JSON.parse(key) as [string, string];
  const frames = Stream.callback<OrchestrationV2CommandOutputFrame, GuestItemReadError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource(itemUrl(GUEST_COMMAND_OUTPUT_ROUTE, shareId, itemId));
        source.addEventListener("message", (message) => {
          const frame = decodeFrame(message.data);
          if (Option.isNone(frame)) return;
          Queue.offerUnsafe(queue, frame.value);
          if (!frame.value.running) {
            source.close();
            Queue.endUnsafe(queue);
          }
        });
        // A non-200 response closes the source for good: the share ended or the item is gone.
        source.addEventListener("error", () => {
          if (source.readyState === EventSource.CLOSED) {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new GuestItemReadError({ message: "Output is no longer available." })),
            );
          }
        });
        return source;
      }),
      (source) => Effect.sync(() => source.close()),
    ),
  );
  // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
  return Atom.make(
    frames.pipe(
      Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
      Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
    ),
  );
});

/** Expanded rows on the guest page read through the guest routes, with the page's share cookie. */
export const guestTurnItemSource = (shareId: string): TurnItemSource => ({
  detail: ({ itemId, revision }) =>
    guestItemDetailAtom(JSON.stringify([shareId, itemId, revision])),
  commandOutput: ({ itemId }) => guestCommandOutputAtom(JSON.stringify([shareId, itemId])),
});
