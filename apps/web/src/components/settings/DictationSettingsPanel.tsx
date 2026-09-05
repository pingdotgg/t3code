import {
  DEFAULT_DICTATION_BASE_URL,
  DEFAULT_DICTATION_CLEANUP_MODEL,
  DEFAULT_DICTATION_CLEANUP_SYSTEM_PROMPT,
} from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { DraftTextarea } from "../ui/draft-textarea";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./settingsLayout";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function DictationSettingsPanel() {
  const dictationEnabled = useClientSettings((settings) => settings.dictationEnabled);
  const dictationApiKey = useClientSettings((settings) => settings.dictationApiKey);
  const dictationBaseUrl = useClientSettings((settings) => settings.dictationBaseUrl);
  const dictationTranscriptionModel = useClientSettings(
    (settings) => settings.dictationTranscriptionModel,
  );
  const dictationLanguage = useClientSettings((settings) => settings.dictationLanguage);
  const dictationCleanupEnabled = useClientSettings((settings) => settings.dictationCleanupEnabled);
  const dictationCleanupModel = useClientSettings((settings) => settings.dictationCleanupModel);
  const dictationCleanupSystemPrompt = useClientSettings(
    (settings) => settings.dictationCleanupSystemPrompt,
  );
  const dictationVocabulary = useClientSettings((settings) => settings.dictationVocabulary);
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("dictation")}>
        <SettingsRow
          title="Enable dictation"
          description="Show a microphone button next to the composer send button. Click to record, click again to transcribe into the composer."
          control={
            <Switch
              checked={dictationEnabled}
              onCheckedChange={(checked) => updateSettings({ dictationEnabled: Boolean(checked) })}
              aria-label="Enable dictation"
            />
          }
        />
        {dictationEnabled ? (
          <>
            <SettingsRow
              title="API key"
              description="Sent only to your transcription provider. Never stored on the T3 Code server — it stays in this browser."
              control={
                <Input
                  type="password"
                  className="w-full sm:w-72"
                  value={dictationApiKey}
                  onChange={(event) => updateSettings({ dictationApiKey: event.target.value })}
                  placeholder="gsk_..."
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Dictation API key"
                />
              }
            />
            <SettingsRow
              title="Base URL"
              description="Any OpenAI-compatible transcription endpoint. Get a free key at console.groq.com."
              resetAction={
                dictationBaseUrl !== DEFAULT_DICTATION_BASE_URL ? (
                  <SettingResetButton
                    label="dictation base URL"
                    onClick={() => updateSettings({ dictationBaseUrl: DEFAULT_DICTATION_BASE_URL })}
                  />
                ) : null
              }
              control={
                <DraftInput
                  className="w-full sm:w-72"
                  value={dictationBaseUrl}
                  onCommit={(next) => updateSettings({ dictationBaseUrl: next.trim() })}
                  placeholder={DEFAULT_DICTATION_BASE_URL}
                  spellCheck={false}
                  aria-label="Dictation base URL"
                />
              }
            />
            <SettingsRow
              title="Transcription model"
              description="Whisper models return segment metadata; other models use plain JSON."
              control={
                <DraftInput
                  className="w-full sm:w-72"
                  value={dictationTranscriptionModel}
                  onCommit={(next) => updateSettings({ dictationTranscriptionModel: next.trim() })}
                  placeholder="whisper-large-v3-turbo"
                  spellCheck={false}
                  aria-label="Dictation transcription model"
                />
              }
            />
            <SettingsRow
              title="Language"
              description="ISO code (e.g. pt, en) to transcribe in. Leave empty to auto-detect."
              control={
                <DraftInput
                  className="w-full sm:w-24"
                  value={dictationLanguage}
                  onCommit={(next) => updateSettings({ dictationLanguage: next.trim() })}
                  placeholder="auto"
                  spellCheck={false}
                  aria-label="Dictation language"
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>
      {dictationEnabled ? (
        <SettingsSection title="Cleanup">
          <SettingsRow
            title="Clean up transcripts"
            description="Polish the raw transcript with a chat model before inserting: remove filler, fix punctuation, keep intent. On failure the raw transcript is used."
            control={
              <Switch
                checked={dictationCleanupEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ dictationCleanupEnabled: Boolean(checked) })
                }
                aria-label="Clean up dictation transcripts"
              />
            }
          />
          {dictationCleanupEnabled ? (
            <>
              <SettingsRow
                title="Cleanup model"
                description="Any OpenAI-compatible chat model on the same base URL."
                resetAction={
                  dictationCleanupModel !== DEFAULT_DICTATION_CLEANUP_MODEL ? (
                    <SettingResetButton
                      label="dictation cleanup model"
                      onClick={() =>
                        updateSettings({ dictationCleanupModel: DEFAULT_DICTATION_CLEANUP_MODEL })
                      }
                    />
                  ) : null
                }
                control={
                  <DraftInput
                    className="w-full sm:w-72"
                    value={dictationCleanupModel}
                    onCommit={(next) => updateSettings({ dictationCleanupModel: next.trim() })}
                    placeholder={DEFAULT_DICTATION_CLEANUP_MODEL}
                    spellCheck={false}
                    aria-label="Dictation cleanup model"
                  />
                }
              />
              <SettingsRow
                title="Custom vocabulary"
                description="Names, jargon, project words — one per line. Used only as a spelling reference for words already spoken."
              >
                <DraftTextarea
                  className="mt-2 w-full"
                  value={dictationVocabulary}
                  onCommit={(next) => updateSettings({ dictationVocabulary: next })}
                  placeholder={"T3 Code\nGroq\nwhisper"}
                  spellCheck={false}
                  aria-label="Dictation custom vocabulary"
                />
              </SettingsRow>
              <SettingsRow
                title="Cleanup prompt"
                description="System prompt for the cleanup pass. Reset restores the freeflow-inspired default."
                resetAction={
                  dictationCleanupSystemPrompt !== DEFAULT_DICTATION_CLEANUP_SYSTEM_PROMPT ? (
                    <SettingResetButton
                      label="dictation cleanup prompt"
                      onClick={() =>
                        updateSettings({
                          dictationCleanupSystemPrompt: DEFAULT_DICTATION_CLEANUP_SYSTEM_PROMPT,
                        })
                      }
                    />
                  ) : null
                }
              >
                <DraftTextarea
                  className="mt-2 w-full font-mono text-xs"
                  value={dictationCleanupSystemPrompt}
                  onCommit={(next) => updateSettings({ dictationCleanupSystemPrompt: next })}
                  spellCheck={false}
                  aria-label="Dictation cleanup prompt"
                />
              </SettingsRow>
            </>
          ) : null}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
