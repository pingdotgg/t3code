import {
  AudioLinesIcon,
  CheckIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  Settings2Icon,
  SparklesIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import { GeminiLiveClient } from "../../voice/geminiLiveClient";
import {
  GEMINI_LIVE_MODELS,
  GEMINI_VOICE_NAMES,
  type GeminiLiveSettings,
  type GeminiLiveStatus,
  type GeminiLiveThreadSnapshot,
  type GeminiVoiceName,
  loadGeminiLiveSettings,
  saveGeminiLiveSettings,
  summarizeMarkdownForVoice,
  type VoiceActivityItem,
} from "../../voice/geminiLiveTypes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface GeminiLiveVoiceControlProps {
  readonly threadKey: string;
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly isWorking: boolean;
  readonly phase: string;
  readonly canInterrupt: boolean;
  readonly pendingApprovalCount: number;
  readonly pendingQuestionText: string | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onSendVoicePrompt: (prompt: string) => Promise<void>;
  readonly onInterruptThread: () => Promise<void>;
  readonly onStartNewThread: () => void;
}

const STATUS_LABELS: Record<GeminiLiveStatus, string> = {
  idle: "Ready",
  connecting: "Connecting...",
  listening: "Listening",
  speaking: "Speaking",
  executing_tool: "Running tool...",
  error: "Error",
};

export function GeminiLiveVoiceControl({
  threadKey,
  threadTitle,
  projectName,
  isWorking,
  phase,
  canInterrupt,
  pendingApprovalCount,
  pendingQuestionText,
  messages,
  onSendVoicePrompt,
  onInterruptThread,
  onStartNewThread,
}: GeminiLiveVoiceControlProps) {
  const [settings, setSettings] = useState<GeminiLiveSettings>(() => loadGeminiLiveSettings());
  const [status, setStatus] = useState<GeminiLiveStatus>("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [activities, setActivities] = useState<ReadonlyArray<VoiceActivityItem>>([]);
  const [apiKeyDraft, setApiKeyDraft] = useState(() => loadGeminiLiveSettings().apiKey);
  const [keySavedFlash, setKeySavedFlash] = useState(false);

  const clientRef = useRef<GeminiLiveClient | null>(null);
  const latestPropsRef = useRef({
    threadKey,
    threadTitle,
    projectName,
    isWorking,
    phase,
    canInterrupt,
    pendingApprovalCount,
    pendingQuestionText,
    messages,
    onSendVoicePrompt,
    onInterruptThread,
    onStartNewThread,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest thread state and handlers in a ref for async WebSocket tool calls
  useEffect(() => {
    latestPropsRef.current = {
      threadKey,
      threadTitle,
      projectName,
      isWorking,
      phase,
      canInterrupt,
      pendingApprovalCount,
      pendingQuestionText,
      messages,
      onSendVoicePrompt,
      onInterruptThread,
      onStartNewThread,
    };
  });

  const buildThreadSnapshot = useStableCallback((): GeminiLiveThreadSnapshot => {
    const current = latestPropsRef.current;
    const recentMessages = current.messages.slice(-6).map((msg) => ({
      role: msg.role,
      text: summarizeMarkdownForVoice(msg.text, 600),
    }));
    return {
      threadTitle: current.threadTitle || "Untitled thread",
      projectName: current.projectName,
      isWorking: current.isWorking,
      phase: current.phase,
      pendingApprovalCount: current.pendingApprovalCount,
      pendingQuestionText: current.pendingQuestionText,
      recentMessages,
    };
  });

  const ensureClient = useStableCallback((): GeminiLiveClient => {
    if (clientRef.current) return clientRef.current;
    const client = new GeminiLiveClient({
      onStatusChange: (nextStatus, nextError) => {
        setStatus(nextStatus);
        if (nextError !== undefined) {
          setErrorText(nextError);
        }
      },
      onInputLevelChange: (level) => {
        setInputLevel(level);
      },
      onOutputLevelChange: (level) => {
        setOutputLevel(level);
      },
      onActivity: (item) => {
        setActivities((prev) => [item, ...prev.slice(0, 24)]);
      },
      getToolHandlers: () => ({
        sendPromptToThread: async (prompt: string) => {
          if (!prompt.trim()) {
            return { ok: false, message: "Prompt cannot be empty." };
          }
          await latestPropsRef.current.onSendVoicePrompt(prompt);
          return {
            ok: true,
            message: `Dispatched prompt to thread "${latestPropsRef.current.threadTitle}". The coding agent is now working on it.`,
          };
        },
        getThreadStatus: () => buildThreadSnapshot(),
        interruptThread: async () => {
          if (!latestPropsRef.current.canInterrupt && !latestPropsRef.current.isWorking) {
            return { ok: false, message: "No active coding agent turn is running right now." };
          }
          await latestPropsRef.current.onInterruptThread();
          return { ok: true, message: "Interrupted the running coding agent turn." };
        },
        startNewThread: async () => {
          latestPropsRef.current.onStartNewThread();
          return { ok: true, message: "Opened a new coding thread." };
        },
      }),
    });
    clientRef.current = client;
    return client;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disconnects the live voice WebSocket and audio contexts when unmounting
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  const isSessionActive =
    status === "connecting" ||
    status === "listening" ||
    status === "speaking" ||
    status === "executing_tool";

  const lastNarratedMessageIdRef = useRef<string | null>(null);
  const lastNarratedQuestionRef = useRef<string | null>(null);
  const wasWorkingRef = useRef(isWorking);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches coding agent turn completion and pending questions to proactively narrate updates over Gemini Live
  useEffect(() => {
    const justFinishedWorking = wasWorkingRef.current && !isWorking;
    wasWorkingRef.current = isWorking;

    if (!isSessionActive || !settings.autoNarrateAgentReplies) {
      return;
    }

    if (pendingQuestionText && pendingQuestionText !== lastNarratedQuestionRef.current) {
      lastNarratedQuestionRef.current = pendingQuestionText;
      clientRef.current?.sendAgentUpdate(
        `The coding agent is asking a question and waiting for user input: ${pendingQuestionText}`,
        "Coding agent asked a question",
      );
      return;
    }
    if (!pendingQuestionText) {
      lastNarratedQuestionRef.current = null;
    }

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && !m.streaming && m.text.trim().length > 0);

    if (
      lastAssistant &&
      (justFinishedWorking || lastNarratedMessageIdRef.current !== null) &&
      lastAssistant.id !== lastNarratedMessageIdRef.current
    ) {
      lastNarratedMessageIdRef.current = lastAssistant.id;
      const summary = summarizeMarkdownForVoice(lastAssistant.text, 1500);
      if (summary) {
        clientRef.current?.sendAgentUpdate(summary, "Coding agent finished turn");
      }
    } else if (lastAssistant && lastNarratedMessageIdRef.current === null && !isWorking) {
      // Seed with existing latest assistant message when session starts so we only narrate new replies.
      lastNarratedMessageIdRef.current = lastAssistant.id;
    }
  }, [
    isSessionActive,
    isWorking,
    messages,
    pendingQuestionText,
    settings.autoNarrateAgentReplies,
  ]);

  const startSession = useStableCallback(async (overrideSettings?: GeminiLiveSettings) => {
    const activeSettings = overrideSettings ?? settings;
    setPanelOpen(true);
    if (!activeSettings.apiKey.trim()) {
      setSettingsOpen(true);
      setStatus("error");
      setErrorText("Paste your Gemini API key below to start Live Voice Mode.");
      return;
    }
    setErrorText(null);
    setMuted(false);
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    lastNarratedMessageIdRef.current = lastAssistant?.id ?? null;
    const client = ensureClient();
    await client.connect(activeSettings);
  });

  const stopSession = useStableCallback(() => {
    clientRef.current?.disconnect();
    setMuted(false);
    setStatus("idle");
  });

  const toggleVoiceMode = useStableCallback(() => {
    if (isSessionActive) {
      setPanelOpen((prev) => !prev);
      return;
    }
    void startSession();
  });

  const toggleMute = useStableCallback(() => {
    const next = !muted;
    setMuted(next);
    clientRef.current?.setMuted(next);
  });

  const narrateLatestReplyNow = useStableCallback(() => {
    if (!isSessionActive) return;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (!lastAssistant) return;
    const summary = summarizeMarkdownForVoice(lastAssistant.text, 1500);
    if (summary) {
      clientRef.current?.sendAgentUpdate(summary, "Manual narration request");
    }
  });

  const updateSettings = (patch: Partial<GeminiLiveSettings>) => {
    const next: GeminiLiveSettings = { ...settings, ...patch };
    setSettings(next);
    saveGeminiLiveSettings(next);
    return next;
  };

  const handleSaveApiKey = () => {
    const next = updateSettings({ apiKey: apiKeyDraft.trim() });
    setKeySavedFlash(true);
    window.setTimeout(() => setKeySavedFlash(false), 1800);
    if (!isSessionActive && next.apiKey) {
      setSettingsOpen(false);
      void startSession(next);
    }
  };

  const activeLevel = Math.max(inputLevel, outputLevel);
  const barMultipliers = [0.45, 0.8, 1, 0.7, 0.5];

  return (
    <>
      {panelOpen ? (
        <div
          data-gemini-live-panel="true"
          className="pointer-events-auto mb-2 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 text-popover-foreground shadow-lg backdrop-blur-md"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div
                className={cn(
                  "relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                  status === "speaking"
                    ? "bg-primary/20 text-primary"
                    : status === "listening"
                      ? "bg-emerald-500/20 text-emerald-500"
                      : status === "executing_tool"
                        ? "bg-amber-500/20 text-amber-500"
                        : status === "error"
                          ? "bg-destructive/20 text-destructive"
                          : "bg-muted text-muted-foreground",
                )}
              >
                <AudioLinesIcon className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-xs">Gemini Live Voice</span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 font-medium text-[10px]",
                      status === "listening" && "bg-emerald-500/15 text-emerald-500",
                      status === "speaking" && "bg-primary/15 text-primary",
                      status === "executing_tool" && "bg-amber-500/15 text-amber-500",
                      status === "connecting" && "bg-muted text-muted-foreground",
                      status === "error" && "bg-destructive/15 text-destructive",
                      status === "idle" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                  {isWorking ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 font-medium text-[10px] text-blue-400">
                      <SparklesIcon className="size-2.5" />
                      Agent coding
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {errorText
                    ? errorText
                    : isSessionActive
                      ? `Voice: ${settings.voiceName} · Talk naturally to coordinate T3 Code`
                      : "Start a real-time voice session with your coding thread"}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {isSessionActive ? (
                <div
                  aria-hidden="true"
                  className="mr-1.5 flex h-6 items-center gap-0.5 px-1.5"
                >
                  {barMultipliers.map((mult, idx) => {
                    const heightPct = Math.max(20, Math.min(100, Math.round(activeLevel * mult * 100)));
                    return (
                      <span
                        key={idx}
                        style={{ height: `${heightPct}%` }}
                        className={cn(
                          "w-1 rounded-full transition-all duration-75",
                          status === "speaking"
                            ? "bg-primary"
                            : muted
                              ? "bg-muted-foreground/30"
                              : "bg-emerald-500",
                        )}
                      />
                    );
                  })}
                </div>
              ) : null}

              {isSessionActive ? (
                <>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant={muted ? "destructive" : "outline"}
                          onClick={toggleMute}
                          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                        />
                      }
                    >
                      {muted ? <MicOffIcon className="size-3.5" /> : <MicIcon className="size-3.5" />}
                    </TooltipTrigger>
                    <TooltipPopup>{muted ? "Unmute mic" : "Mute mic"}</TooltipPopup>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          onClick={narrateLatestReplyNow}
                          aria-label="Read latest agent response aloud"
                        />
                      }
                    >
                      <Volume2Icon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup>Narrate latest agent reply</TooltipPopup>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="destructive"
                          onClick={stopSession}
                          aria-label="End voice session"
                        />
                      }
                    >
                      <PhoneOffIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup>Disconnect voice</TooltipPopup>
                  </Tooltip>
                </>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  onClick={() => void startSession()}
                >
                  <MicIcon className="mr-1 size-3.5" />
                  Connect
                </Button>
              )}

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={settingsOpen ? "secondary" : "ghost"}
                      onClick={() => setSettingsOpen((prev) => !prev)}
                      aria-label="Voice settings"
                    />
                  }
                >
                  <Settings2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Voice settings</TooltipPopup>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setPanelOpen(false)}
                      aria-label="Minimize voice panel"
                    />
                  }
                >
                  <XIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Hide panel</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {settingsOpen ? (
            <div className="grid gap-2.5 border-b border-border/60 bg-muted/30 px-3.5 py-3 text-xs">
              <div className="grid gap-1">
                <label
                  htmlFor="gemini-live-api-key"
                  className="font-medium text-[11px] text-muted-foreground"
                >
                  Gemini API Key (saved locally in browser)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id="gemini-live-api-key"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder="AIzaSy..."
                    className="h-7 flex-1 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                  <Button type="button" size="xs" onClick={handleSaveApiKey}>
                    {keySavedFlash ? (
                      <>
                        <CheckIcon className="mr-1 size-3" />
                        Saved
                      </>
                    ) : (
                      "Save & Connect"
                    )}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="grid gap-1">
                  <label
                    htmlFor="gemini-live-voice-select"
                    className="font-medium text-[11px] text-muted-foreground"
                  >
                    Voice
                  </label>
                  <select
                    id="gemini-live-voice-select"
                    value={settings.voiceName}
                    onChange={(e) =>
                      updateSettings({ voiceName: e.target.value as GeminiVoiceName })
                    }
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {GEMINI_VOICE_NAMES.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-1 sm:col-span-2">
                  <label
                    htmlFor="gemini-live-model-select"
                    className="font-medium text-[11px] text-muted-foreground"
                  >
                    Live Model
                  </label>
                  <select
                    id="gemini-live-model-select"
                    value={settings.model}
                    onChange={(e) => updateSettings({ model: e.target.value })}
                    className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {GEMINI_LIVE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={settings.autoNarrateAgentReplies}
                  onChange={(e) =>
                    updateSettings({ autoNarrateAgentReplies: e.target.checked })
                  }
                  className="rounded border-input"
                />
                Automatically speak when the coding agent finishes a turn or asks a question
              </label>
            </div>
          ) : null}

          {activities.length > 0 ? (
            <div className="max-h-28 overflow-y-auto px-3.5 py-2">
              <div className="space-y-1">
                {activities.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-baseline justify-between gap-2 text-[11px]"
                  >
                    <div className="min-w-0 flex-1 truncate">
                      <span
                        className={cn(
                          "mr-1.5 font-medium",
                          item.kind === "tool" && "text-amber-500",
                          item.kind === "agent_update" && "text-blue-400",
                          item.kind === "assistant" && "text-primary",
                          item.kind === "system" && "text-muted-foreground",
                        )}
                      >
                        [{item.title}]
                      </span>
                      {item.detail ? (
                        <span className="text-muted-foreground">{item.detail}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="pointer-events-auto flex justify-end pb-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="gemini-live-voice-button"
                onClick={toggleVoiceMode}
                aria-label={
                  isSessionActive
                    ? `Live Voice Active (${STATUS_LABELS[status]})`
                    : "Start Gemini Live Voice Mode"
                }
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 font-medium text-xs shadow-xs transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isSessionActive
                    ? status === "speaking"
                      ? "border-primary/50 bg-primary text-primary-foreground"
                      : "border-emerald-500/40 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25"
                    : "border-border/70 bg-background/90 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              />
            }
          >
            <AudioLinesIcon className="size-3.5" />
            <span>
              {isSessionActive ? STATUS_LABELS[status] : "Live Voice"}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {isSessionActive
              ? "Toggle Gemini Live Voice panel"
              : "Talk to T3 Code with Gemini Live Voice"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );
}
