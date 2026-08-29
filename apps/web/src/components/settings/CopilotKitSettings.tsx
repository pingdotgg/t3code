import { COPILOTKIT_REVIEW_MODEL_IDS, type CopilotKitReviewModel } from "@t3tools/contracts";
import { useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { CopilotKitIcon } from "../copilotkit/CopilotKitIcon";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const REVIEW_MODEL_LABELS: Readonly<Record<CopilotKitReviewModel, string>> = {
  "openai/gpt-5-mini": "OpenAI GPT-5 Mini",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash-preview": "Gemini 3 Flash Preview",
};

export function CopilotKitSettingsPanel() {
  const copilotKit = usePrimarySettings((settings) => settings.copilotKit);
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "CopilotKit settings update",
  );
  const [keySaveState, setKeySaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const saveOpenRouterApiKey = async (value: string) => {
    const openRouterApiKey = value.trim();
    if (openRouterApiKey.length === 0) return;
    if (primaryEnvironmentId === null) {
      setKeySaveState("failed");
      return;
    }
    setKeySaveState("saving");
    const result = await persistServerSettings({
      environmentId: primaryEnvironmentId,
      input: { patch: { copilotKit: { openRouterApiKey } } },
    });
    setKeySaveState(AsyncResult.isSuccess(result) ? "saved" : "failed");
  };

  const apiKeyStatus =
    keySaveState === "saving"
      ? "Saving API key…"
      : keySaveState === "saved"
        ? "API key saved. The next review will use it."
        : keySaveState === "failed"
          ? "Could not save the API key. Check the server connection and try again."
          : copilotKit.openRouterApiKeyConfigured
            ? "API key configured. Enter another key to replace it."
            : "Required before CopilotKit Review can run.";

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="copilotkit-review"
        title="CopilotKit Review"
        icon={<CopilotKitIcon className="size-4" />}
      >
        <SettingsRow
          {...searchableSetting("copilotkit-openrouter-api-key")}
          description="Paste an OpenRouter API key and press Enter. T3 saves it securely for this server and never sends it back to the browser."
          status={apiKeyStatus}
          control={
            <DraftInput
              aria-label="OpenRouter API key"
              autoCapitalize="off"
              autoComplete="off"
              className="w-full sm:w-72"
              disabled={keySaveState === "saving"}
              maxLength={512}
              onCommit={(value) => void saveOpenRouterApiKey(value)}
              placeholder={copilotKit.openRouterApiKeyConfigured ? "Stored securely" : "sk-or-v1-…"}
              spellCheck={false}
              type="password"
              value=""
            />
          }
        />

        <SettingsRow
          {...searchableSetting("copilotkit-review-model")}
          description="Model used when the review pane checks the current branch. Choosing a model saves it immediately."
          control={
            <Select
              value={copilotKit.reviewModel}
              onValueChange={(reviewModel) => {
                if (
                  reviewModel &&
                  COPILOTKIT_REVIEW_MODEL_IDS.includes(reviewModel as CopilotKitReviewModel)
                ) {
                  updateSettings({
                    copilotKit: { reviewModel: reviewModel as CopilotKitReviewModel },
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="CopilotKit review model">
                <SelectValue>{REVIEW_MODEL_LABELS[copilotKit.reviewModel]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {COPILOTKIT_REVIEW_MODEL_IDS.map((reviewModel) => (
                  <SelectItem hideIndicator key={reviewModel} value={reviewModel}>
                    {REVIEW_MODEL_LABELS[reviewModel]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
