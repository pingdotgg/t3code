/**
 * Voice control row: connect, mute, end, clear. Dumb component; all state
 * and behavior come from the controller via props.
 */
export interface VoiceControlsProps {
  readonly phase: "idle" | "connecting" | "live" | "closing" | "closed" | "error";
  readonly starting: boolean;
  readonly micMuted: boolean;
  readonly onConnect: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
  readonly onClear: () => void;
}

const PHASE_LABELS: Record<VoiceControlsProps["phase"], string> = {
  idle: "Idle",
  connecting: "Connecting…",
  live: "Live",
  closing: "Ending…",
  closed: "Ended",
  error: "Error",
};

export function phaseLabel(phase: VoiceControlsProps["phase"], micMuted: boolean): string {
  if (phase === "live" && micMuted) {
    return "Muted";
  }
  return PHASE_LABELS[phase];
}

export function VoiceControls(props: VoiceControlsProps) {
  const sessionInactive =
    props.phase === "idle" || props.phase === "closed" || props.phase === "error";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground" data-voice-phase={props.phase}>
        {props.starting ? "Starting…" : phaseLabel(props.phase, props.micMuted)}
      </span>
      <button
        type="button"
        className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.starting || !sessionInactive}
        onClick={props.onConnect}
      >
        Connect
      </button>
      <button
        type="button"
        className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.phase !== "live"}
        onClick={props.onToggleMute}
      >
        {props.micMuted ? "Unmute" : "Mute"}
      </button>
      <button
        type="button"
        className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
        // End is the cancel for a pending connection: available whenever
        // startup work is in flight (including the initial idle-starting
        // state before a client exists), and for any live session phase.
        // Disabled only when there is genuinely nothing to cancel: idle or
        // closed with no startup in flight.
        disabled={(props.phase === "idle" || props.phase === "closed") && !props.starting}
        onClick={props.onEnd}
      >
        End
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        disabled={
          props.phase === "live" || props.phase === "connecting" || props.phase === "closing"
        }
        onClick={props.onClear}
      >
        Clear
      </button>
    </div>
  );
}
