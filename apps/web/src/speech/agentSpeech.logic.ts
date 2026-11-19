import type { SpeechSettings } from "@t3tools/contracts";

import { completedSentencesSince } from "./speechText";

export interface ObservedMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** What has been read of each message in the watched thread. */
export interface SpeechTracker {
  /** Characters of raw message text already handed to speech. */
  readonly spoken: Map<string, number>;
  /** Messages finished with (read, skipped, or present before watching began). */
  readonly done: Set<string>;
  /** Older messages arriving later, such as a page of history, are not new. */
  readonly since: number;
}

export type SpeechAction =
  | { readonly type: "speak"; readonly messageId: string; readonly markdown: string }
  | { readonly type: "append"; readonly messageId: string; readonly markdown: string };

export function createSpeechTracker(
  existing: ReadonlyArray<ObservedMessage>,
  now: number,
): SpeechTracker {
  // History already on screen is never read automatically.
  const newest = Math.max(0, ...existing.map((message) => message.createdAt));
  return {
    spoken: new Map(),
    done: new Set(existing.map((message) => message.id)),
    since: Math.min(now, newest > 0 ? newest : now),
  };
}

/**
 * Decides what to read after the thread's messages change. Completed mode reads a message once
 * it stops streaming; streaming mode reads finished sentences as they arrive.
 */
export function nextSpeechActions(
  tracker: SpeechTracker,
  messages: ReadonlyArray<ObservedMessage>,
  settings: Pick<SpeechSettings, "readMode" | "maxCharacters">,
): SpeechAction[] {
  const actions: SpeechAction[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || tracker.done.has(message.id)) continue;
    if (message.createdAt < tracker.since) {
      tracker.done.add(message.id);
      continue;
    }
    if (settings.readMode === "completed") {
      if (message.streaming) continue;
      tracker.done.add(message.id);
      if (message.text.trim() !== "") {
        actions.push({ type: "speak", messageId: message.id, markdown: message.text });
      }
      continue;
    }
    const spoken = tracker.spoken.get(message.id) ?? 0;
    const piece = message.streaming
      ? completedSentencesSince(message.text, spoken)
      : spoken < message.text.length
        ? { text: message.text.slice(spoken), end: message.text.length }
        : null;
    if (!message.streaming) tracker.done.add(message.id);
    if (piece === null || piece.text.trim() === "") continue;
    tracker.spoken.set(message.id, piece.end);
    if (spoken >= settings.maxCharacters) continue;
    actions.push({
      type: spoken === 0 ? "speak" : "append",
      messageId: message.id,
      markdown: piece.text,
    });
  }
  return actions;
}
