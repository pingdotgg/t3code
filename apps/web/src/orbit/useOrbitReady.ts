import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { orbitCompletionPhase } from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import type { OrbitReadyTimelineInput } from "../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../session-logic";
import type { ChatMessage } from "../types";
import { useOrbitInstance } from "./environmentProvider";
import { orbitReadyView, orbitSetupView } from "./orbitSetupView";
import { dismissOrbitThreadStart, retrySavedOrbitCompletion } from "./orbitThreadStarts";
import { useSentOrbitThreadStart } from "./orbitThreadStartStore";

/**
 * Conn: the Orbit row of a thread a pending Orbit start handed over to: the setup card while the
 * create's completion runs or failed, then "Instance ready".
 */
export function useOrbitReady(
  environmentId: string | null,
  threadId: string | null,
): OrbitReadyTimelineInput | null {
  const sent = useSentOrbitThreadStart(threadId);
  const start = sent !== null && sent.environmentId === environmentId ? sent : null;
  const url =
    useOrbitInstance(start === null ? null : EnvironmentId.make(start.environmentId!))?.url ?? null;
  if (start === null) return null;
  const completion = orbitCompletionPhase(start);
  const id = start.id;
  const setup = completion === "none" || completion === "succeeded" ? null : orbitSetupView(start);
  return {
    view: orbitReadyView(start, url),
    setup,
    onRetry: () => retrySavedOrbitCompletion(id),
    onDismiss: () => dismissOrbitThreadStart(id),
    messageId: start.messageId,
    firstMessage: {
      text: start.message,
      createdAt: new Date(start.sentAt ?? start.createdAt).toISOString(),
    },
    locksComposer: setup !== null,
    threadRef: scopeThreadRef(
      EnvironmentId.make(start.environmentId!),
      ThreadId.make(start.threadId),
    ),
  };
}

/**
 * The timeline with the Orbit start's first message in front while the thread's own messages have
 * not loaded yet and the Instance is still being made, so the hand-over from the pending thread
 * keeps the message and the card in place. Once any message is loaded, the entries stay as they are.
 */
export function withOrbitFirstMessage(
  entries: ReadonlyArray<TimelineEntry>,
  orbitReady: OrbitReadyTimelineInput | null,
  detailLoading = false,
): ReadonlyArray<TimelineEntry> {
  const first = orbitReady?.firstMessage;
  // Only while the Instance is being made or the thread's messages first load: a later empty
  // timeline (a rewind) stays empty.
  if (!orbitReady || !first || (orbitReady.locksComposer !== true && !detailLoading)) {
    return entries;
  }
  if (entries.some((entry) => entry.kind === "message")) return entries;
  const message: ChatMessage = {
    id: MessageId.make(orbitReady.messageId),
    role: "user",
    text: first.text,
    runId: null,
    streaming: false,
    createdAt: first.createdAt,
    updatedAt: first.createdAt,
  };
  return [
    { id: orbitReady.messageId, kind: "message", createdAt: first.createdAt, message },
    ...entries,
  ];
}
