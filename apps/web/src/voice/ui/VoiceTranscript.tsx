/**
 * Voice transcript and status display. Dumb component; driven entirely by
 * controller state (ordered chat utterances, the in-flight tool indicator,
 * and readable navigation/error outcomes).
 */
import { useEffect, useRef } from "react";
import type { VoiceToolError } from "@t3tools/contracts";

import { describeVoiceToolError } from "./voicePanelController";
import type { VoiceUtterance } from "./voicePanelController";

export interface VoiceTranscriptProps {
  readonly utterances: ReadonlyArray<VoiceUtterance>;
  readonly inFlightTool: string | null;
  readonly error: VoiceToolError | null;
  readonly navigationStatus: string | null;
  readonly navigationFailed: boolean;
}

/** Whether the element is scrolled to (or within a few pixels of) the
    bottom. The scroll decision is extracted so behavior tests can exercise
    it without a real layout engine. */
export const isNearBottom = (element: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean => element.scrollHeight - element.scrollTop - element.clientHeight < 24;

const SPEAKER_LABELS: Record<VoiceUtterance["channel"], string> = {
  input: "You",
  output: "Assistant",
};

export function VoiceTranscript(props: VoiceTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Captured by the scroll handler: only follow the stream when the user
      was already reading the latest entry, never yank them away from
      scrolled-up history. Re-measured after every render; when already at
      the bottom, re-following is a no-op, so no change key is needed. */
  const wasNearBottom = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && wasNearBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });
  const hasContent =
    props.utterances.length > 0 ||
    props.error !== null ||
    props.navigationStatus !== null ||
    props.inFlightTool !== null;
  if (!hasContent) {
    return null;
  }
  return (
    <div
      ref={scrollRef}
      className="flex max-h-64 min-h-0 flex-col gap-1.5 overflow-y-auto text-xs"
      onScroll={(event) => {
        wasNearBottom.current = isNearBottom(event.currentTarget);
      }}
    >
      {props.inFlightTool !== null ? (
        <p className="font-medium text-muted-foreground" data-voice-in-flight={props.inFlightTool}>
          Working: {props.inFlightTool}
        </p>
      ) : null}
      {props.error !== null ? (
        <p
          className="font-medium text-destructive"
          role="alert"
          data-voice-error={props.error.code}
        >
          {describeVoiceToolError(props.error)}
        </p>
      ) : null}
      {props.navigationStatus !== null ? (
        <p
          className={props.navigationFailed ? "font-medium text-destructive" : "text-foreground"}
          data-voice-navigation={props.navigationFailed ? "failed" : "ok"}
        >
          {props.navigationStatus}
        </p>
      ) : null}
      {props.utterances.map((utterance) => (
        <p
          key={utterance.id}
          className={utterance.channel === "input" ? "text-muted-foreground" : "text-foreground"}
          data-voice-utterance={utterance.id}
          data-voice-speaker={utterance.channel}
        >
          <span className="font-medium">{SPEAKER_LABELS[utterance.channel]}: </span>
          {utterance.text}
        </p>
      ))}
    </div>
  );
}
