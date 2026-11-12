import { useVoiceTranscriptionDestination } from "../../speech/useEnvironmentSpeechInput";
import {
  useRetainedVoiceInputSession,
  useVoiceInputSessionActivity,
  useVoiceInputSessionSnapshot,
  useVoiceOwnerPresented,
} from "../../speech/voiceInputSession";
import { Button } from "../ui/button";
import { ComposerSpeechRecordingPill } from "./ComposerSpeechButton";

/**
 * Keeps the chosen destination's dictation alive across navigation and, while the draft it
 * records into is off screen, shows it so it can be finished, cancelled, or returned to.
 */
export function GlobalVoiceInputIndicator() {
  const { prepared, grantId, cloudProvider, cloudModel } = useVoiceTranscriptionDestination();
  const session = useRetainedVoiceInputSession({ prepared, grantId, cloudProvider, cloudModel });
  const { state, target, recordingStartedAt } = useVoiceInputSessionSnapshot(session);
  const presented = useVoiceOwnerPresented(target?.ownerKey ?? null);
  const { level } = useVoiceInputSessionActivity(
    presented ? null : session,
    target?.ownerKey ?? null,
  );
  if (!session || !target || state.phase === "idle" || presented) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-100 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full bg-popover p-0.5 shadow-lg/5">
        <Button
          type="button"
          size="sm-pill"
          variant="ghost"
          disabled={!target.open}
          onClick={() => target.open?.()}
          className="min-w-0 shrink"
        >
          <span className="truncate">{target.label ?? "Untitled thread"}</span>
        </Button>
        <ComposerSpeechRecordingPill
          state={state}
          progress={null}
          level={level}
          recordingStartedAt={recordingStartedAt}
          onStart={() => void session.start(target)}
          onStop={() => void session.stop()}
          onCancel={() => session.cancel()}
          onSkipPostProcessing={() => session.skipPostProcessing()}
        />
      </div>
    </div>
  );
}
