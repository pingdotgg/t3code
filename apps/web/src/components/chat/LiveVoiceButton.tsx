import * as Option from "effect/Option";
import type { EnvironmentId, ThreadId, LiveVoiceOptions, LiveVoiceState } from "@t3tools/contracts";
import {
  liveVoiceOptions,
  startLiveVoice,
  pollLiveVoice,
  stopLiveVoice,
} from "@t3tools/client-runtime/voice-input";
import { HeadphonesIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePreparedConnection } from "../../state/session";
import { chooseRecordingMicrophone } from "../../speech/browserMicrophones";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { BrowserLiveVoice, type LiveVoicePhase } from "../../speech/browserLiveVoice";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function LiveVoiceButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  disabled: boolean;
  onActiveChange(active: boolean): void;
}) {
  const { disabled, onActiveChange } = props;
  const prepared = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<LiveVoiceOptions | null>(null);
  const [voice, setVoice] = useState("");
  const [phase, setPhase] = useState<LiveVoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcripts, setTranscripts] = useState<LiveVoiceState["transcripts"]>([]);
  const client = useRef<BrowserLiveVoice | null>(null);
  const loading = useRef(0);
  const active = phase === "connecting" || phase === "connected";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release microphone and peer resources when the selected environment or conversation unmounts.
  useEffect(() => {
    if (disabled || !prepared) client.current?.stop();
    return () => {
      loading.current++;
      client.current?.stop(false);
      onActiveChange(false);
    };
  }, [disabled, onActiveChange, prepared]);

  async function changeOpen(next: boolean) {
    setOpen(next);
    const request = ++loading.current;
    if (!next) {
      client.current?.stop();
      props.onActiveChange(false);
      return;
    }
    setError(null);
    setOptions(null);
    if (!prepared) {
      setError("Reconnect this environment before starting voice.");
      return;
    }
    try {
      const result = await runEnvironmentSpeech(liveVoiceOptions(prepared, props.threadId));
      if (loading.current !== request) return;
      setOptions(result);
      setVoice((previous) => (result.voices.includes(previous) ? previous : result.defaultVoice));
    } catch (cause) {
      if (loading.current === request)
        setError(
          cause instanceof Error
            ? cause.message
            : "Subscription voice is unavailable for this account.",
        );
    }
  }
  function start() {
    if (!prepared || !voice) return;
    setMuted(false);
    setError(null);
    client.current?.stop(false);
    const connection = new BrowserLiveVoice({
      open: (sessionId, selected, sdp, signal) =>
        runEnvironmentSpeech(
          startLiveVoice(prepared, { threadId: props.threadId, sessionId, voice: selected, sdp }),
          { signal },
        ),
      poll: (id, revision, signal) =>
        runEnvironmentSpeech(pollLiveVoice(prepared, id, revision), { signal }),
      stop: (id) => runEnvironmentSpeech(stopLiveVoice(prepared, id)),
      getMicrophoneId: chooseRecordingMicrophone,
      onTranscript: setTranscripts,
      onPhase: (next, message) => {
        setPhase(next);
        setError(message);
        props.onActiveChange(next === "connected" || next === "connecting");
      },
    });
    client.current = connection;
    void connection.start(voice);
  }
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        type="button"
        title="ChatGPT live voice"
        aria-label="ChatGPT live voice"
        disabled={props.disabled}
        onClick={() => void changeOpen(true)}
      >
        <HeadphonesIcon />
      </Button>
      <Dialog modal={false} open={open} onOpenChange={(next) => void changeOpen(next)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>ChatGPT live voice</DialogTitle>
            <DialogDescription>
              Use the ChatGPT account connected to this conversation. Voice requests appear as
              normal T3 tasks.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span>Voice</span>
                <Select
                  value={voice}
                  onValueChange={(value) => {
                    if (value) setVoice(value);
                  }}
                  disabled={active || !options}
                >
                  <SelectTrigger aria-label="Voice">
                    <SelectValue placeholder="Loading voices…">
                      {voice ? voice.charAt(0).toUpperCase() + voice.slice(1) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {options?.voices.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value.charAt(0).toUpperCase() + value.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <p role="status" className="text-sm text-muted-foreground">
                {phase === "connecting"
                  ? "Connecting…"
                  : phase === "connected"
                    ? muted
                      ? "Microphone muted"
                      : "Listening"
                    : "Microphone is off"}
              </p>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div
                className="max-h-72 space-y-3 overflow-y-auto"
                aria-label="Voice transcript"
                aria-live="polite"
              >
                {transcripts.map((item) => (
                  <p key={item.id} className="text-sm">
                    <strong>{item.role === "user" ? "You" : "Voice"}: </strong>
                    {item.text}
                  </p>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                This transcript is shown for the current voice session. Ending voice leaves any
                coding tasks running in the conversation.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            {active ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = !muted;
                    client.current?.mute(next);
                    setMuted(next);
                  }}
                >
                  <span>{muted ? <MicOffIcon /> : <MicIcon />}</span>
                  {muted ? "Unmute" : "Mute"}
                </Button>
                <Button variant="destructive" onClick={() => client.current?.stop()}>
                  <PhoneOffIcon />
                  End voice
                </Button>
              </>
            ) : (
              <Button disabled={!options || !voice || props.disabled} onClick={start}>
                <HeadphonesIcon />
                Start voice
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
