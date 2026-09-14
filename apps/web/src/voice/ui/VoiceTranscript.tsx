/**
 * Voice transcript and status display. Dumb component; driven entirely by
 * controller state (client transcript deltas, the in-flight tool indicator,
 * and readable navigation/error outcomes).
 */
import type { VoiceToolError } from "@t3tools/contracts";

import { describeVoiceToolError } from "./voicePanelController";

export interface VoiceTranscriptProps {
  readonly inputTranscript: string;
  readonly outputTranscript: string;
  readonly inFlightTool: string | null;
  readonly error: VoiceToolError | null;
  readonly navigationStatus: string | null;
  readonly navigationFailed: boolean;
}

export function VoiceTranscript(props: VoiceTranscriptProps) {
  const hasContent =
    props.inputTranscript.length > 0 ||
    props.outputTranscript.length > 0 ||
    props.error !== null ||
    props.navigationStatus !== null ||
    props.inFlightTool !== null;
  if (!hasContent) {
    return null;
  }
  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto text-xs">
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
      {props.inputTranscript.length > 0 ? (
        <p className="text-muted-foreground">
          <span className="font-medium">You: </span>
          {props.inputTranscript}
        </p>
      ) : null}
      {props.outputTranscript.length > 0 ? (
        <p className="text-foreground">
          <span className="font-medium">Assistant: </span>
          {props.outputTranscript}
        </p>
      ) : null}
    </div>
  );
}
