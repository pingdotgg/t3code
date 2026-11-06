import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  GaugeIcon,
  Globe2Icon,
  HistoryIcon,
  KeyRoundIcon,
  LoaderIcon,
  Mic2Icon,
  Trash2Icon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { VoiceTraceTimeline } from "../voice/VoiceTraceTimeline";
import {
  DEFAULT_VOICE_SPEED,
  isVoiceLanguage,
  isVoiceName,
  isVoiceNoiseReduction,
  isVoiceRealtimeModel,
  isVoiceReasoningEffort,
  isVoiceTurnEagerness,
  VOICE_LANGUAGE_OPTIONS,
  VOICE_MODEL_OPTIONS,
  VOICE_NOISE_REDUCTION_OPTIONS,
  VOICE_OPTIONS,
  VOICE_REASONING_OPTIONS,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  VOICE_SPEED_STEP,
  VOICE_TURN_EAGERNESS_OPTIONS,
  voiceLanguageLabel,
  useVoiceSettingsStore,
  CODEX_VOICE_OPTIONS,
  isCodexVoiceName,
} from "../voice/voiceSettingsStore";
import { useVoiceTraceStore } from "../voice/voiceTraceStore";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { APP_DISPLAY_NAME } from "~/branding";

/** Sentinel for the select: an empty stored voice means whatever Codex picks. */
const CODEX_DEFAULT_VOICE = "codex-default";

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return "The voice request failed.";
}

function RealtimeVoiceSettingsContent({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const statusResult = useAtomValue(
    serverEnvironment.voiceCredentialStatus({ environmentId, input: {} }),
  );
  const queriedStatus = Option.getOrNull(AsyncResult.value(statusResult));
  const parallelStatusResult = useAtomValue(
    serverEnvironment.parallelCredentialStatus({ environmentId, input: {} }),
  );
  const queriedParallelStatus = Option.getOrNull(AsyncResult.value(parallelStatusResult));
  const setCredential = useAtomCommand(serverEnvironment.setVoiceCredential, {
    reportFailure: false,
  });
  const removeCredential = useAtomCommand(serverEnvironment.removeVoiceCredential, {
    reportFailure: false,
  });
  const createVoiceSession = useAtomCommand(serverEnvironment.createVoiceSession, {
    reportFailure: false,
  });
  const setParallelCredential = useAtomCommand(serverEnvironment.setParallelCredential, {
    reportFailure: false,
  });
  const removeParallelCredential = useAtomCommand(serverEnvironment.removeParallelCredential, {
    reportFailure: false,
  });
  const searchVoiceWeb = useAtomCommand(serverEnvironment.searchVoiceWeb, {
    reportFailure: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [parallelApiKey, setParallelApiKey] = useState("");
  const [parallelConfigured, setParallelConfigured] = useState(false);
  const [parallelBusy, setParallelBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [parallelFeedback, setParallelFeedback] = useState<string | null>(null);
  const traceSessions = useVoiceTraceStore((state) => state.sessions);
  const clearTraceHistory = useVoiceTraceStore((state) => state.clearHistory);
  const voiceProvider = useVoiceSettingsStore((state) => state.provider);
  const setVoiceProvider = useVoiceSettingsStore((state) => state.setProvider);
  const codexVoice = useVoiceSettingsStore((state) => state.codexVoice);
  const setCodexVoice = useVoiceSettingsStore((state) => state.setCodexVoice);
  const voiceModel = useVoiceSettingsStore((state) => state.model);
  const voiceName = useVoiceSettingsStore((state) => state.voice);
  const voiceSpeed = useVoiceSettingsStore((state) => state.speed);
  const voiceLanguage = useVoiceSettingsStore((state) => state.language);
  const reasoningEffort = useVoiceSettingsStore((state) => state.reasoningEffort);
  const turnEagerness = useVoiceSettingsStore((state) => state.turnEagerness);
  const noiseReduction = useVoiceSettingsStore((state) => state.noiseReduction);
  const setVoiceModel = useVoiceSettingsStore((state) => state.setModel);
  const setVoiceName = useVoiceSettingsStore((state) => state.setVoice);
  const setVoiceSpeed = useVoiceSettingsStore((state) => state.setSpeed);
  const setVoiceLanguage = useVoiceSettingsStore((state) => state.setLanguage);
  const setReasoningEffort = useVoiceSettingsStore((state) => state.setReasoningEffort);
  const setTurnEagerness = useVoiceSettingsStore((state) => state.setTurnEagerness);
  const setNoiseReduction = useVoiceSettingsStore((state) => state.setNoiseReduction);

  useEffect(() => {
    if (queriedStatus) setConfigured(queriedStatus.configured);
  }, [queriedStatus]);

  useEffect(() => {
    if (queriedParallelStatus) setParallelConfigured(queriedParallelStatus.configured);
  }, [queriedParallelStatus]);

  const save = async () => {
    if (!environmentId || apiKey.trim().length === 0 || busy) return;
    setBusy("save");
    setFeedback(null);
    const result = await setCredential({ environmentId, input: { apiKey } });
    setBusy(null);
    if (result._tag === "Success") {
      setConfigured(true);
      setApiKey("");
      setFeedback(`API key saved securely on this ${APP_DISPLAY_NAME} environment.`);
    } else {
      setFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  const test = async () => {
    if (!environmentId || !configured || busy) return;
    setBusy("test");
    setFeedback(null);
    const result = await createVoiceSession({ environmentId, input: { model: voiceModel } });
    setBusy(null);
    setFeedback(
      result._tag === "Success"
        ? "Connection successful. OpenAI Realtime is ready."
        : messageFromError(squashAtomCommandFailure(result)),
    );
  };

  const remove = async () => {
    if (!environmentId || !configured || busy) return;
    setBusy("remove");
    setFeedback(null);
    const result = await removeCredential({ environmentId, input: {} });
    setBusy(null);
    if (result._tag === "Success") {
      setConfigured(false);
      setFeedback("Saved OpenAI API key removed.");
    } else {
      setFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  const saveParallel = async () => {
    if (!environmentId || parallelApiKey.trim().length === 0 || parallelBusy) return;
    setParallelBusy("save");
    setParallelFeedback(null);
    const result = await setParallelCredential({
      environmentId,
      input: { apiKey: parallelApiKey },
    });
    setParallelBusy(null);
    if (result._tag === "Success") {
      setParallelConfigured(true);
      setParallelApiKey("");
      setParallelFeedback(
        `Parallel API key saved securely on this ${APP_DISPLAY_NAME} environment.`,
      );
    } else {
      setParallelFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  const testParallel = async () => {
    if (!environmentId || !parallelConfigured || parallelBusy) return;
    setParallelBusy("test");
    setParallelFeedback(null);
    const result = await searchVoiceWeb({
      environmentId,
      input: {
        objective: "Verify that Parallel Search is available.",
        searchQueries: ["Parallel AI official website"],
      },
    });
    setParallelBusy(null);
    setParallelFeedback(
      result._tag === "Success"
        ? "Connection successful. Parallel Search is ready."
        : messageFromError(squashAtomCommandFailure(result)),
    );
  };

  const removeParallel = async () => {
    if (!environmentId || !parallelConfigured || parallelBusy) return;
    setParallelBusy("remove");
    setParallelFeedback(null);
    const result = await removeParallelCredential({ environmentId, input: {} });
    setParallelBusy(null);
    if (result._tag === "Success") {
      setParallelConfigured(false);
      setParallelFeedback("Saved Parallel API key removed.");
    } else {
      setParallelFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  return (
    <>
      <SettingsSection
        id={searchableSetting("voice-conversations").id}
        title="Voice conversations"
        icon={<Mic2Icon className="size-3.5" />}
      >
        <SettingsRow
          title="Provider"
          description={`Talk with ${APP_DISPLAY_NAME} in a live voice session. Codex account uses your ChatGPT sign-in on this environment. Spoken requests go to the selected model in the task where voice started. Uses the microphone chosen above. Changes apply to the next voice session.`}
          control={
            <Select
              value={voiceProvider}
              onValueChange={(value) => {
                if (value === "codex-account" || value === "openai-api") setVoiceProvider(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-72" aria-label="Voice provider">
                <SelectValue>
                  {voiceProvider === "codex-account"
                    ? "Codex account · GPT-Live"
                    : "OpenAI API · Realtime"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="codex-account">Codex account · GPT-Live</SelectItem>
                <SelectItem value="openai-api">OpenAI API · Realtime</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        {voiceProvider === "codex-account" ? (
          <SettingsRow
            title="Voice"
            description="Which GPT-Live voice speaks. Applies to the next voice session."
            control={
              <Select
                value={codexVoice || CODEX_DEFAULT_VOICE}
                onValueChange={(value) => {
                  const next = value === CODEX_DEFAULT_VOICE ? "" : value;
                  if (isCodexVoiceName(next)) setCodexVoice(next);
                }}
              >
                <SelectTrigger className="w-full sm:w-72" aria-label="Codex voice">
                  <SelectValue>
                    {CODEX_VOICE_OPTIONS.find((option) => option.value === codexVoice)?.label ??
                      "Codex default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {CODEX_VOICE_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.value || CODEX_DEFAULT_VOICE}
                      value={option.value || CODEX_DEFAULT_VOICE}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        {voiceProvider === "codex-account" ? (
          <SettingsRow
            title="ChatGPT account"
            description="Uses the Codex sign-in in Settings → Providers. No OpenAI API key is needed. Requires Codex with GPT-Live support and an eligible ChatGPT account. Claude and other agents keep using their own provider sign-ins. Voice and delegated work use your accounts' normal limits."
          />
        ) : null}
      </SettingsSection>

      {voiceProvider === "openai-api" ? (
        <>
          <SettingsSection title="OpenAI Realtime" icon={<Mic2Icon className="size-3.5" />}>
            <SettingsRow
              title="API key"
              description={`Stored only by the selected ${APP_DISPLAY_NAME} server. The app uses it to mint short-lived browser credentials.`}
              status={
                <span className={configured ? "text-emerald-600 dark:text-emerald-400" : undefined}>
                  {configured ? "Configured" : "Not configured"}
                </span>
              }
            >
              <div className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row">
                <Input
                  nativeInput
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                  placeholder={configured ? "Enter a replacement OpenAI API key" : "sk-…"}
                  aria-label="OpenAI API key"
                />
                <Button
                  className="shrink-0"
                  size="sm"
                  onClick={() => void save()}
                  disabled={!environmentId || apiKey.trim().length === 0 || busy !== null}
                >
                  {busy === "save" ? (
                    <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <KeyRoundIcon className="size-3.5" />
                  )}
                  Save key
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow
              title="Connection"
              description="Validate the saved key by requesting a short-lived OpenAI Realtime client secret."
              status={feedback}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void test()}
                    disabled={!environmentId || !configured || busy !== null}
                  >
                    {busy === "test" ? (
                      <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <CheckCircle2Icon className="size-3.5" />
                    )}
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void remove()}
                    disabled={!environmentId || !configured || busy !== null}
                  >
                    {busy === "remove" ? (
                      <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    Remove
                  </Button>
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection title="Parallel Web" icon={<Globe2Icon className="size-3.5" />}>
            <SettingsRow
              title="API key"
              description={`Stored only by the selected ${APP_DISPLAY_NAME} server. The voice agent uses Parallel Search and Extract through server-side tools.`}
              status={
                <span
                  className={
                    parallelConfigured ? "text-emerald-600 dark:text-emerald-400" : undefined
                  }
                >
                  {parallelConfigured ? "Configured" : "Not configured"}
                </span>
              }
            >
              <div className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row">
                <Input
                  nativeInput
                  type="password"
                  autoComplete="off"
                  value={parallelApiKey}
                  onChange={(event) => setParallelApiKey(event.currentTarget.value)}
                  placeholder={
                    parallelConfigured ? "Enter a replacement Parallel API key" : "Parallel API key"
                  }
                  aria-label="Parallel API key"
                />
                <Button
                  className="shrink-0"
                  size="sm"
                  onClick={() => void saveParallel()}
                  disabled={
                    !environmentId || parallelApiKey.trim().length === 0 || parallelBusy !== null
                  }
                >
                  {parallelBusy === "save" ? (
                    <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <KeyRoundIcon className="size-3.5" />
                  )}
                  Save key
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow
              title="Search and Extract"
              description="Validate the saved key with a small live Search request. Extract is used only when ranked search excerpts are insufficient."
              status={parallelFeedback}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void testParallel()}
                    disabled={!environmentId || !parallelConfigured || parallelBusy !== null}
                  >
                    {parallelBusy === "test" ? (
                      <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <CheckCircle2Icon className="size-3.5" />
                    )}
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void removeParallel()}
                    disabled={!environmentId || !parallelConfigured || parallelBusy !== null}
                  >
                    {parallelBusy === "remove" ? (
                      <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    Remove
                  </Button>
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection title="Voice preferences" icon={<GaugeIcon className="size-3.5" />}>
            <SettingsRow
              title="Model"
              description="Mini is the recommended default for conversational speed and cost. The full model is stronger for difficult explanations and tool decisions. Changes apply to the next session."
              control={
                <Select
                  value={voiceModel}
                  onValueChange={(value) => {
                    if (isVoiceRealtimeModel(value)) setVoiceModel(value);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Realtime model">
                    <SelectValue>
                      {VOICE_MODEL_OPTIONS.find((option) => option.value === voiceModel)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <div>
                          <div>{option.label}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {option.description}
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Voice"
              description="Choose the generated voice. OpenAI recommends Marin or Cedar. The voice is fixed after a session first speaks."
              control={
                <Select
                  value={voiceName}
                  onValueChange={(value) => {
                    if (isVoiceName(value)) setVoiceName(value);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="OpenAI voice">
                    <SelectValue>
                      {VOICE_OPTIONS.find((option) => option.value === voiceName)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Speech pace"
              description="Adjust OpenAI's post-processing playback speed. Changes are applied between model turns."
              status={`${VOICE_SPEED_MIN.toFixed(2)}× minimum · ${DEFAULT_VOICE_SPEED.toFixed(1)}× recommended · ${VOICE_SPEED_MAX.toFixed(1)}× maximum`}
              control={
                <div className="flex w-full items-center gap-3 sm:w-64">
                  <input
                    id="voice-speech-pace"
                    className="h-5 min-w-0 flex-1 cursor-pointer accent-primary"
                    type="range"
                    min={VOICE_SPEED_MIN}
                    max={VOICE_SPEED_MAX}
                    step={VOICE_SPEED_STEP}
                    value={voiceSpeed}
                    aria-label="OpenAI speech pace"
                    aria-valuetext={`${voiceSpeed.toFixed(2)} times speed`}
                    onChange={(event) => setVoiceSpeed(event.currentTarget.valueAsNumber)}
                  />
                  <output
                    htmlFor="voice-speech-pace"
                    className="w-11 shrink-0 text-right font-mono text-xs font-medium tabular-nums"
                  >
                    {voiceSpeed.toFixed(2)}×
                  </output>
                </div>
              }
            />
            <SettingsRow
              title="Input language"
              description="Optionally bias input transcription with an ISO-639-1 language code. Auto is recommended for multilingual conversations and does not restrict the language OpenAI speaks."
              control={
                <Select
                  value={voiceLanguage}
                  onValueChange={(value) => {
                    if (isVoiceLanguage(value)) setVoiceLanguage(value);
                  }}
                >
                  <SelectTrigger
                    className="w-full sm:w-72"
                    aria-label="Input transcription language"
                  >
                    <SelectValue>{voiceLanguageLabel(voiceLanguage)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Reasoning effort"
              description="Controls the latency and depth tradeoff. OpenAI recommends Low for most production voice agents."
              control={
                <Select
                  value={reasoningEffort}
                  onValueChange={(value) => {
                    if (isVoiceReasoningEffort(value)) setReasoningEffort(value);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Reasoning effort">
                    <SelectValue>
                      {
                        VOICE_REASONING_OPTIONS.find((option) => option.value === reasoningEffort)
                          ?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_REASONING_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Turn taking"
              description="Semantic VAD waits for the meaning of your sentence, not only a fixed silence. Patient waits longer; Quick responds sooner."
              control={
                <Select
                  value={turnEagerness}
                  onValueChange={(value) => {
                    if (isVoiceTurnEagerness(value)) setTurnEagerness(value);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Turn-taking eagerness">
                    <SelectValue>
                      {
                        VOICE_TURN_EAGERNESS_OPTIONS.find(
                          (option) => option.value === turnEagerness,
                        )?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_TURN_EAGERNESS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Microphone profile"
              description="OpenAI filters audio before turn detection and model input. Choose the profile matching the microphone distance."
              control={
                <Select
                  value={noiseReduction}
                  onValueChange={(value) => {
                    if (isVoiceNoiseReduction(value)) setNoiseReduction(value);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Microphone noise profile">
                    <SelectValue>
                      {
                        VOICE_NOISE_REDUCTION_OPTIONS.find(
                          (option) => option.value === noiseReduction,
                        )?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {VOICE_NOISE_REDUCTION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>
        </>
      ) : null}

      <SettingsSection title="Voice conversation behavior">
        <SettingsRow
          title="One global session"
          description="Voice stays active while you move between tasks or other applications. Starting voice elsewhere reopens the existing session instead of creating another one."
        />
        <SettingsRow
          title="Context and composer access"
          description={
            voiceProvider === "codex-account"
              ? "Voice sends requests to the model selected in the task where you started voice and speaks its answer. Work and approval requests appear in that task. End voice to switch tasks. Ending voice leaves already-started agent work running."
              : "The latest AI message is shared initially. OpenAI can page older messages, search web sources through Parallel, and edit unsent composer text, but cannot send prompts."
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Conversation history"
        icon={<HistoryIcon className="size-3.5" />}
        headerAction={
          traceSessions.length > 0 ? (
            <Button size="xs" variant="ghost" onClick={clearTraceHistory}>
              Clear history
            </Button>
          ) : null
        }
      >
        {traceSessions.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">
            Completed conversations and tool traces will appear here.
          </div>
        ) : (
          traceSessions.map((session) => (
            <details key={session.id} className="group border-t border-border/60 first:border-t-0">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 marker:hidden sm:px-5">
                <span
                  className={
                    session.status === "error"
                      ? "size-2 rounded-full bg-destructive"
                      : session.status === "active"
                        ? "size-2 rounded-full bg-emerald-500"
                        : "size-2 rounded-full bg-muted-foreground/45"
                  }
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {session.title}
                </span>
                <time className="shrink-0 text-[11px] text-muted-foreground">
                  {new Date(session.startedAt).toLocaleString()}
                </time>
              </summary>
              <div className="border-t border-border/50">
                <VoiceTraceTimeline entries={session.entries} className="max-h-80" />
              </div>
            </details>
          ))
        )}
      </SettingsSection>
    </>
  );
}

/** MT Code: realtime voice sessions (Codex GPT-Live or OpenAI Realtime), below dictation. */
export function RealtimeVoiceSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  if (!primaryEnvironment) {
    return (
      <SettingsSection
        id={searchableSetting("voice-conversations").id}
        title="Voice conversations"
        icon={<Mic2Icon className="size-3.5" />}
      >
        <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">
          Connecting to the primary environment…
        </p>
      </SettingsSection>
    );
  }
  return <RealtimeVoiceSettingsContent environmentId={primaryEnvironment.environmentId} />;
}
