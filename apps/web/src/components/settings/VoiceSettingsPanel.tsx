import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  GaugeIcon,
  HistoryIcon,
  KeyRoundIcon,
  LoaderIcon,
  Mic2Icon,
  Trash2Icon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
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
  VOICE_LANGUAGE_OPTIONS,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  VOICE_SPEED_STEP,
  voiceLanguageLabel,
  useVoiceSettingsStore,
} from "../voice/voiceSettingsStore";
import { useVoiceTraceStore } from "../voice/voiceTraceStore";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return "The voice request failed.";
}

function VoiceSettingsContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const statusResult = useAtomValue(
    serverEnvironment.voiceCredentialStatus({ environmentId, input: {} }),
  );
  const queriedStatus = Option.getOrNull(AsyncResult.value(statusResult));
  const setCredential = useAtomCommand(serverEnvironment.setVoiceCredential, {
    reportFailure: false,
  });
  const removeCredential = useAtomCommand(serverEnvironment.removeVoiceCredential, {
    reportFailure: false,
  });
  const createVoiceSession = useAtomCommand(serverEnvironment.createVoiceSession, {
    reportFailure: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const traceSessions = useVoiceTraceStore((state) => state.sessions);
  const clearTraceHistory = useVoiceTraceStore((state) => state.clearHistory);
  const voiceSpeed = useVoiceSettingsStore((state) => state.speed);
  const voiceLanguage = useVoiceSettingsStore((state) => state.language);
  const setVoiceSpeed = useVoiceSettingsStore((state) => state.setSpeed);
  const setVoiceLanguage = useVoiceSettingsStore((state) => state.setLanguage);

  useEffect(() => {
    if (queriedStatus) setConfigured(queriedStatus.configured);
  }, [queriedStatus]);

  const save = async () => {
    if (!environmentId || apiKey.trim().length === 0 || busy) return;
    setBusy("save");
    setFeedback(null);
    const result = await setCredential({ environmentId, input: { apiKey } });
    setBusy(null);
    if (result._tag === "Success") {
      setConfigured(true);
      setApiKey("");
      setFeedback("API key saved securely on this T3 Code environment.");
    } else {
      setFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  const test = async () => {
    if (!environmentId || !configured || busy) return;
    setBusy("test");
    setFeedback(null);
    const result = await createVoiceSession({ environmentId, input: {} });
    setBusy(null);
    setFeedback(
      result._tag === "Success"
        ? "Connection successful. Grok Voice is ready."
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
      setFeedback("Saved xAI API key removed.");
    } else {
      setFeedback(messageFromError(squashAtomCommandFailure(result)));
    }
  };

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Voice</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the global Grok voice layer for T3 Code.
        </p>
      </div>

      <SettingsSection title="xAI Voice" icon={<Mic2Icon className="size-3.5" />}>
        <SettingsRow
          title="API key"
          description="Stored only by the selected T3 Code server. The app uses it to mint short-lived browser credentials."
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
              placeholder={configured ? "Enter a replacement xAI API key" : "xai-…"}
              aria-label="xAI API key"
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
          description="Validate the saved key by requesting a short-lived Grok Voice session credential."
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

      <SettingsSection title="Voice preferences" icon={<GaugeIcon className="size-3.5" />}>
        <SettingsRow
          title="Speech pace"
          description="Adjust how quickly Grok speaks. Changes apply to the active voice session."
          status={`${VOICE_SPEED_MIN.toFixed(1)}× minimum · ${DEFAULT_VOICE_SPEED.toFixed(1)}× recommended · ${VOICE_SPEED_MAX.toFixed(1)}× maximum`}
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
                aria-label="Grok speech pace"
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
          title="Spoken language"
          description="Bias speech recognition toward a supported language. Auto detects the language and is recommended for multilingual conversations."
          control={
            <Select
              value={voiceLanguage}
              onValueChange={(value) => {
                if (isVoiceLanguage(value)) setVoiceLanguage(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="Grok spoken language">
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
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingsRow
          title="One global session"
          description="Voice stays active while you move between tasks or other applications. Starting voice elsewhere reopens the existing session instead of creating another one."
        />
        <SettingsRow
          title="Context and composer access"
          description="The latest AI message is shared initially. Grok can page older messages from that task, search the web, and edit unsent composer text, but it cannot send prompts."
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
          traceSessions.map((session, index) => (
            <details
              key={session.id}
              className="group border-t border-border/60 first:border-t-0"
              open={index === 0}
            >
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
              <div className="border-t border-border/50 bg-muted/15 p-3">
                <VoiceTraceTimeline
                  entries={session.entries}
                  className="max-h-80 rounded-xl border border-border/60 bg-background/50"
                />
              </div>
            </details>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function VoiceSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  if (!primaryEnvironment) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">Connecting to the primary environment…</p>
      </SettingsPageContainer>
    );
  }
  return <VoiceSettingsContent environmentId={primaryEnvironment.environmentId} />;
}
