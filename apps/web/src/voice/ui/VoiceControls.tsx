/**
 * Voice control row: connect, mute, end, clear, plus the activation-mode
 * talk control. Dumb component; all state and behavior come from the
 * controller via props.
 */
import type { VoiceActivationMode } from "./overlayPreferences";

export interface VoiceControlsProps {
  readonly phase: "idle" | "connecting" | "live" | "closing" | "closed" | "error";
  readonly starting: boolean;
  readonly micMuted: boolean;
  readonly onConnect: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
  readonly onClear: () => void;
  /** Activation mode from the device-local overlay preferences; default
      "manual" keeps the plain Connect button. */
  readonly activation?: VoiceActivationMode | undefined;
  /** Hold mode: press starts the session, release ends it. */
  readonly onTalkPress?: () => void;
  readonly onTalkRelease?: () => void;
  /** Double-press mode: double-click toggles the session. */
  readonly onTalkToggle?: () => void;
}

const PHASE_LABELS: Record<VoiceControlsProps["phase"], string> = {
  idle: "Idle",
  connecting: "Connecting…",
  live: "Live",
  closing: "Ending…",
  closed: "Ended",
  error: "Error",
};

export function phaseLabel(
  phase: VoiceControlsProps["phase"],
  micMuted: boolean,
  activation: VoiceActivationMode = "manual",
): string {
  if (phase === "live" && micMuted) {
    return "Muted";
  }
  if (activation === "always" && phase === "idle") {
    return "Auto";
  }
  return PHASE_LABELS[phase];
}

export function VoiceControls(props: VoiceControlsProps) {
  const sessionInactive =
    props.phase === "idle" || props.phase === "closed" || props.phase === "error";
  const activation = props.activation ?? "manual";
  const talkInactive = sessionInactive && !props.starting;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground" data-voice-phase={props.phase}>
        {props.starting ? "Starting…" : phaseLabel(props.phase, props.micMuted, activation)}
      </span>
      {activation === "manual" && (
        <button
          type="button"
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={props.starting || !sessionInactive}
          onClick={props.onConnect}
        >
          Connect
        </button>
      )}
      {activation === "hold" && (
        <button
          type="button"
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground select-none"
          // Press starts the session (no-op when one is already live);
          // release ends it. Handlers no-op unless the phase matches.
          onPointerDown={props.onTalkPress}
          onPointerUp={props.onTalkRelease}
          onPointerLeave={props.onTalkRelease}
        >
          Hold to talk
        </button>
      )}
      {activation === "double-press" && (
        <button
          type="button"
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground select-none"
          onDoubleClick={props.onTalkToggle}
        >
          Talk
        </button>
      )}
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
      {activation === "double-press" && (
        <span className="text-xs text-muted-foreground">
          {talkInactive ? "Double-click Talk to listen" : undefined}
        </span>
      )}
    </div>
  );
}
