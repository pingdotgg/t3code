import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import type { DesktopDictationResult, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { randomUUID } from "~/lib/utils";
import { DesktopVoiceRecorder } from "./desktopVoiceCapture";
import { resolveDesktopTranscript } from "./desktopDictationDraft";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** Own microphone capture for one composer and commit editable local transcripts only to that draft. */
export function DesktopDictationControl(props: {
  ownerKey: string;
  disabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  readDraft: () => { text: string; cursor: number };
  insertDraft: (text: string, cursor: number) => void;
  composerFocused: () => boolean;
  onStateChange: (ownerKey: string, state: VoiceInputState) => void;
}) {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const [options, setOptions] = useState(false);
  const [model, setModel] = useState<DesktopDictationResult | null>(null);
  const [voice, setVoice] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const latest = useRef({ props, settings });
  useLayoutEffect(() => {
    latest.current = { props, settings };
  }, [props, settings]);
  const controller = useRef<VoiceInputController | null>(null);
  const mounted = useRef(false);
  const held = useRef<string | null>(null);
  const modelOperation = useRef<string | null>(null);
  const bridge = window.desktopBridge?.dictation;
  const active = voiceInputBlocksSubmission(voice);
  const checkModel = useCallback(async () => {
    if (!bridge) return null;
    try {
      const value = await bridge({ action: "status" });
      if (mounted.current) setModel(value);
      return value;
    } catch {
      if (mounted.current) setMessage("The desktop dictation service is unavailable.");
      return null;
    }
  }, [bridge]);
  const refreshDevices = useCallback(async () => {
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "audioinput",
      );
      if (mounted.current) setDevices(inputs);
    } catch {
      if (mounted.current)
        setMessage("Microphones are unavailable. Check operating-system permissions.");
    }
  }, []);
  /** Ask the native desktop picker to approve a CLI path; renderer text cannot select executable code. */
  async function selectExecutable(action: "choose-executable" | "reset-executable") {
    if (!bridge) return;
    try {
      const result = await bridge({ action });
      if (result.executablePath !== undefined)
        await updateSettings({ dictationExecutablePath: result.executablePath });
      if (mounted.current) {
        setModel(result);
        setMessage(result.message);
      }
    } catch {
      if (mounted.current) setMessage("Could not select the executable. Try again.");
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (!bridge)
      return () => {
        mounted.current = false;
      };
    let revision = 0;
    let previous = "";
    /** Snapshot the original composer's text, revision, and insertion position for safe transcript rebasing. */
    const readDraft = (): VoiceDraftSnapshot | null => {
      const current = latest.current.props;
      if (current.ownerKey !== props.ownerKey || current.disabled) return null;
      const draft = current.readDraft();
      if (draft.text !== previous) {
        revision++;
        previous = draft.text;
      }
      return {
        ownerKey: current.ownerKey,
        text: draft.text,
        selection: { start: draft.cursor, end: draft.cursor },
        revision,
      };
    };
    /** Present a dictation failure while preserving the current composer draft. */
    const notifyError = (error: unknown) => {
      if (!mounted.current) return;
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission was denied. Enable it for T3 Code in system privacy settings, then retry."
          : error instanceof DOMException &&
              ["NotFoundError", "OverconstrainedError"].includes(error.name)
            ? "The selected microphone is unavailable. Choose another microphone."
            : error instanceof Error
              ? error.message
              : "Microphone recording failed.",
      );
    };
    const recorder = new DesktopVoiceRecorder(
      () => latest.current.settings.dictationMicrophoneId,
      (error) => {
        if (error) void controller.current?.interruptRecording(error);
        else
          void controller.current?.handleRecorderStatus({
            isFinished: true,
            hasError: false,
            error: null,
            url: recorder.uri,
          });
      },
    );
    const recording: typeof recorder = recorder;
    const originalPrepare = recording.prepareToRecordAsync.bind(recording);
    recording.prepareToRecordAsync = async () => {
      try {
        await originalPrepare();
      } catch (error) {
        notifyError(error);
        await recording.release();
        throw error;
      }
    };
    const instance = new VoiceInputController({
      recorder: recording,
      resolveCommit: resolveDesktopTranscript,
      captureDraftAtStart: true,
      requestPermission: async () => {
        // Only called from Start. Probe permission without retaining a stream while a
        // model is prepared; prepareToRecordAsync then owns the actual capture stream.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          stream.getTracks().forEach((track) => track.stop());
          void refreshDevices();
          return { granted: true, canAskAgain: true };
        } catch (error) {
          notifyError(error);
          return { granted: false, canAskAgain: false };
        }
      },
      configureRecording: async () => {},
      releaseRecording: () => recording.release(),
      deleteRecording: () => recording.clear(),
      readDraft,
      commitDraft: (text, selection) => {
        if (latest.current.props.ownerKey !== props.ownerKey) return;
        latest.current.props.insertDraft(text, selection.start);
        if (mounted.current) {
          setTranscript("");
          setMessage("Completed — transcript added to the draft. Review it before sending.");
        }
      },
      onStateChange: (state) => {
        if (mounted.current) {
          latest.current.props.onStateChange(props.ownerKey, state);
          setVoice(state);
        }
      },
      getTranscriber: () => ({
        prepare: async ({ signal }) => {
          const status = await bridge({ action: "status" });
          if (signal.aborted) throw new Error("Cancelled");
          if (status.state !== "ready") {
            if (mounted.current) {
              setModel(status);
              setOptions(true);
            }
            throw new Error(status.message);
          }
          return {
            locale: "en",
            transcribe: async (_uri, { signal: transcribeSignal }) => {
              const operationId = randomUUID();
              const cancel = () => {
                void bridge({ action: "cancel", operationId });
              };
              transcribeSignal.addEventListener("abort", cancel, { once: true });
              try {
                if (transcribeSignal.aborted) throw new Error("Cancelled");
                const result = await bridge({
                  action: "transcribe",
                  operationId,
                  audio: recording.audio(),
                });
                if (transcribeSignal.aborted) throw new Error("Cancelled");
                if (result.state !== "completed") {
                  if (mounted.current) setMessage(result.message);
                  throw new Error(result.message);
                }
                if (mounted.current) setTranscript(result.transcript ?? "");
                return result.transcript ?? "";
              } finally {
                transcribeSignal.removeEventListener("abort", cancel);
              }
            },
          };
        },
      }),
    });
    controller.current = instance;
    const close = () => {
      instance.dispose();
      void recorder.release();
    };
    window.addEventListener("beforeunload", close);
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => {
      mounted.current = false;
      instance.dispose();
      latest.current.props.onStateChange(props.ownerKey, {
        phase: "idle",
        error: null,
        errorAction: null,
      });
      void recorder.release();
      controller.current = null;
      window.removeEventListener("beforeunload", close);
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
    };
  }, [props.ownerKey, bridge, refreshDevices]);
  useEffect(() => {
    if (props.disabled) controller.current?.ownerChanged();
  }, [props.disabled]);
  /** Start or stop the current composer's voice session without submitting its draft. */
  async function toggle(expectedHold?: string) {
    const instance = controller.current;
    if (!instance || props.disabled) return;
    if (instance.currentState.phase === "recording") {
      void instance.stop();
      return;
    }
    if (
      instance.currentState.phase === "preparing" ||
      instance.currentState.phase === "transcribing"
    )
      return;
    setMessage("");
    setTranscript("");
    if (expectedHold && held.current !== expectedHold) return;
    await instance.start();
  }
  function cancel() {
    controller.current?.cancel();
    setTranscript("");
    setMessage("Cancelled — your draft is unchanged.");
    held.current = null;
  }
  const onDictationKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      controller.current &&
      !["idle", "error"].includes(controller.current.currentState.phase)
    ) {
      event.preventDefault();
      cancel();
      return;
    }
    const command = resolveShortcutCommand(event, props.keybindings, {
      context: { composerFocus: props.composerFocused(), isDesktop: true, isWeb: false },
    });
    if (command !== "composer.dictationHold" && command !== "composer.dictationToggle") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || props.disabled) return;
    if (command === "composer.dictationHold") held.current = event.code;
    void toggle(command === "composer.dictationHold" ? event.code : undefined);
  });
  const onDictationKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (!held.current) return;
    // macOS may omit Space key-up while Cmd is held; modifier release must
    // also stop the hold so recording cannot continue unnoticed.
    const modifierReleased = ["Meta", "Control", "Shift", "Alt"].includes(event.key);
    if (event.code !== held.current && !modifierReleased) return;
    held.current = null;
    if (controller.current?.currentState.phase === "recording") void controller.current.stop();
    else if (controller.current?.currentState.phase === "preparing") cancel();
  });
  const onDictationBlur = useEffectEvent(() => {
    if (held.current) cancel();
  });
  useEffect(() => {
    const down = (event: KeyboardEvent) => onDictationKeyDown(event);
    const up = (event: KeyboardEvent) => onDictationKeyUp(event);
    const blur = () => onDictationBlur();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (model?.state !== "downloading") return;
    const timer = setInterval(() => {
      void checkModel();
    }, 500);
    return () => clearInterval(timer);
  }, [model?.state, checkModel]);
  if (!bridge) return null;
  return (
    <div className="relative flex items-center gap-1">
      <Button
        type="button"
        size="icon-sm"
        variant={active ? "secondary" : "ghost"}
        disabled={props.disabled || voice.phase === "transcribing" || voice.phase === "preparing"}
        aria-label={
          voice.phase === "recording"
            ? "Stop dictation and transcribe locally"
            : "Start local voice dictation"
        }
        aria-description={
          shortcutLabelForCommand(props.keybindings, "composer.dictationToggle", {
            context: { composerFocus: true },
          }) ?? "Local dictation"
        }
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => void toggle()}
      >
        {voice.phase === "recording" ? <Square /> : <Mic />}
      </Button>
      {active ? (
        <>
          <span role="status" className="text-xs">
            {voice.phase}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel dictation"
            onClick={cancel}
          >
            <X />
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Dictation settings and status"
        onClick={() => {
          setOptions((v) => !v);
          void checkModel();
          void refreshDevices();
        }}
      >
        Voice
      </Button>
      {options || !!message || !!voice.error || !!transcript ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 grid max-h-[70vh] w-96 max-w-[80vw] gap-2 overflow-auto rounded-lg border bg-popover p-3 text-sm shadow-lg">
          <div className="flex items-center justify-between">
            <strong>Local dictation</strong>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close dictation panel"
              onClick={() => {
                setOptions(false);
                setMessage("");
                if (voice.phase === "error") controller.current?.cancel();
              }}
            >
              <X />
            </Button>
          </div>
          <p role={voice.error ? "alert" : "status"}>
            {message ||
              voice.error ||
              model?.message ||
              "Audio is transcribed on this desktop, even when your agent is remote."}
          </p>
          {transcript ? (
            <>
              <Textarea
                aria-label="Uninserted transcript"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
              />
              <p>The captured location changed. Review this transcript and insert it explicitly.</p>
              <Button
                type="button"
                onClick={() => {
                  const draft = props.readDraft();
                  const result = resolveDesktopTranscript(
                    {
                      ownerKey: props.ownerKey,
                      text: draft.text,
                      selection: { start: draft.cursor, end: draft.cursor },
                      revision: 0,
                    },
                    {
                      ownerKey: props.ownerKey,
                      text: draft.text,
                      selection: { start: draft.cursor, end: draft.cursor },
                      revision: 0,
                    },
                    transcript,
                    "en",
                  );
                  if (result.kind === "commit") {
                    props.insertDraft(result.text, result.selection.start);
                    setTranscript("");
                    controller.current?.cancel();
                    setMessage("Transcript added to the draft.");
                  }
                }}
              >
                Insert at current cursor
              </Button>
              <Button type="button" variant="outline" onClick={() => setTranscript("")}>
                Discard transcript
              </Button>
            </>
          ) : null}
          {options ? (
            <>
              <label>
                Microphone
                <select
                  className="block w-full rounded border bg-background p-2"
                  value={settings.dictationMicrophoneId}
                  disabled={active}
                  onChange={(e) => void updateSettings({ dictationMicrophoneId: e.target.value })}
                >
                  <option value="">System default</option>
                  {devices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                whisper-cli executable (blank uses the platform default)
                <Input value={settings.dictationExecutablePath} readOnly />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={active}
                onClick={() => void selectExecutable("choose-executable")}
              >
                Choose whisper-cli executable…
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={active || !settings.dictationExecutablePath}
                onClick={() => void selectExecutable("reset-executable")}
              >
                Use platform default
              </Button>
              <p>
                Whisper tiny, multilingual, 75 MiB. Downloaded from Hugging Face only when you
                choose Install. Audio stays on this computer. This model favors speed; check the
                transcript for errors.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={active || model?.state === "downloading"}
                  onClick={() => {
                    const operationId = randomUUID();
                    modelOperation.current = operationId;
                    setModel({
                      state: "downloading",
                      message: "Starting model download…",
                      downloadedBytes: 0,
                      totalBytes: 0,
                    });
                    void bridge({ action: "install", operationId })
                      .then((value) => {
                        if (mounted.current) setModel(value);
                      })
                      .catch(() => {
                        if (mounted.current) setMessage("Model installation failed. Try again.");
                      })
                      .finally(() => {
                        modelOperation.current = null;
                      });
                  }}
                >
                  Install local model (75 MiB)
                </Button>
                {model?.state === "downloading" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void bridge({
                        action: "cancel",
                        ...(modelOperation.current ? { operationId: modelOperation.current } : {}),
                      })
                    }
                  >
                    Cancel download
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={active}
                    onClick={() => void bridge({ action: "remove" }).then(setModel)}
                  >
                    Remove model
                  </Button>
                )}
              </div>
              {model?.state === "downloading" ? (
                <>
                  <progress
                    max={model.totalBytes || undefined}
                    value={model.totalBytes ? model.downloadedBytes : undefined}
                    aria-label="Model download progress"
                  />
                  <p>{(model.downloadedBytes / 1024 / 1024).toFixed(1)} MiB downloaded</p>
                </>
              ) : (
                <p>{model?.message}</p>
              )}
              <p>
                Configure <code>composer.dictationToggle</code> and{" "}
                <code>composer.dictationHold</code> in Settings → Keybindings. Hold mode stops when
                you release its key.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
