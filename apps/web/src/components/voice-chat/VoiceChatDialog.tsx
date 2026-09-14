import { MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import type { VoiceChatState } from "./useVoiceChat";

export function VoiceChatDialog({
  open,
  state,
  onClose,
  onStart,
  onMutedChange,
}: {
  open: boolean;
  state: VoiceChatState;
  onClose: () => void;
  onStart: () => void;
  onMutedChange: (muted: boolean) => void;
}) {
  const active = state.status === "connected" || state.status === "connecting";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Voice chat</DialogTitle>
          <DialogDescription>
            Talk with GPT-Live about this thread. Your audio is sent to OpenAI while the call is
            active.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-4">
          <p role="status" className="text-sm text-muted-foreground">
            {state.status === "connecting"
              ? "Connecting..."
              : state.status === "connected"
                ? state.muted
                  ? "Microphone muted"
                  : "Connected"
                : "Call ended"}
          </p>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {state.transcript.length > 0 ? (
            <div
              aria-label="Voice transcript"
              className="max-h-64 space-y-3 overflow-y-auto text-sm"
            >
              {state.transcript.map((entry, index) => (
                <p key={index}>
                  <span className="font-medium">
                    {entry.role === "user" ? "You" : "GPT-Live"}:{" "}
                  </span>
                  {entry.text}
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {active ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onMutedChange(!state.muted)}
              aria-pressed={state.muted}
            >
              {state.muted ? <MicOffIcon /> : <MicIcon />}
              {state.muted ? "Unmute" : "Mute"}
            </Button>
          ) : (
            <Button type="button" onClick={onStart}>
              Start again
            </Button>
          )}
          <Button type="button" variant={active ? "destructive" : "outline"} onClick={onClose}>
            <PhoneOffIcon />
            {active ? "End call" : "Close"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
