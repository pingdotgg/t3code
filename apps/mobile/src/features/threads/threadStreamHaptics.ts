// @effect-diagnostics globalDate:off - The tracker runs in an atom subscription, outside an Effect runtime.
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";

import { environmentThreadDetails } from "../../state/threads";

export interface StreamingMessageMark {
  readonly id: string;
  readonly textLength: number;
}

const STREAM_HAPTIC_THROTTLE_MS = 320;

export function latestStreamingAssistantMessage(
  thread: EnvironmentThread | null,
): StreamingMessageMark | null {
  const messages = thread?.projection.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.streaming) {
      return { id: message.id, textLength: message.text.length };
    }
  }
  return null;
}

/**
 * A new stream always ticks; growth of the same stream ticks at most once per
 * throttle window, so a fast stream reads as texture rather than a buzz.
 */
export function shouldTickStreamHaptic(input: {
  readonly previous: StreamingMessageMark | null;
  readonly latest: StreamingMessageMark | null;
  readonly lastTickAt: number;
  readonly now: number;
}): boolean {
  const { previous, latest } = input;
  if (latest === null) return false;
  if (previous?.id !== latest.id) return true;
  if (latest.textLength <= previous.textLength) return false;
  return input.now - input.lastTickAt >= STREAM_HAPTIC_THROTTLE_MS;
}

const streamHapticsFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    // The first snapshot only seeds the mark: opening a thread mid-stream is silent.
    let seeded = false;
    let previous: StreamingMessageMark | null = null;
    let lastTickAt = 0;
    // `subscribe`, not `get`: a rebuild per streaming tick would reset the mark.
    get.subscribe(
      environmentThreadDetails.threadAtom(ref),
      (thread) => {
        const latest = latestStreamingAssistantMessage(thread);
        const now = Date.now();
        const tick = seeded && shouldTickStreamHaptic({ previous, latest, lastTickAt, now });
        seeded = true;
        previous = latest;
        if (!tick) return;
        lastTickAt = now;
        void Haptics.selectionAsync();
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`thread-stream-haptics:${key}`));
});

// A thread without server detail (a draft) has no reply to stream.
const noStreamHaptics = Atom.make<void>(undefined).pipe(
  Atom.withLabel("thread-stream-haptics:none"),
);

/** Mount while the thread is on screen to tick haptics as its reply streams. */
export function threadStreamHaptics(ref: ScopedThreadRef | null): Atom.Atom<void> {
  return ref === null ? noStreamHaptics : streamHapticsFamily(threadKey(ref));
}
