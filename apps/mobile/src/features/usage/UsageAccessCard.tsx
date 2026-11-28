import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  withProviderUsageAccess,
  type EnvironmentId,
  type ProviderUsageAccess,
  type UsageAccessRequest,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export interface UsageAccessPrompt extends UsageAccessRequest {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

/** What usage access lets T3 Code read for this agent. Keep in step with web's usage access card. */
function usageAccessReads(driver: string, gt: ReturnType<typeof useGT>): string {
  switch (driver) {
    case "claudeAgent":
    case "grok":
      return gt("Session history and sign-in");
    case "opencode":
      return gt("Usage database and Go key");
    case "antigravity":
      return gt("Conversation history");
    case "cursor":
      return gt("Account usage from Cursor");
    default:
      return gt("Session history");
  }
}

const promptKey = (prompt: UsageAccessPrompt) => `${prompt.environmentId}\0${prompt.instanceId}`;

/** Asks before T3 reads an agent's usage files or sign-in. It stays until every agent is answered. */
export function UsageAccessCard({ prompts }: { readonly prompts: readonly UsageAccessPrompt[] }) {
  const gt = useGT();
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const [declined, setDeclined] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showEnvironment = new Set(prompts.map((prompt) => prompt.environmentId)).size > 1;

  const answer = async (allowSelected: boolean) => {
    setSaving(true);
    setError(null);
    const results = await Promise.all(
      prompts.map((prompt) => {
        const access: ProviderUsageAccess =
          allowSelected && !declined.has(promptKey(prompt)) ? "allowed" : "denied";
        const config = appAtomRegistry.get(serverEnvironment.configValueAtom(prompt.environmentId));
        return mutateProviderInstance({
          environmentId: prompt.environmentId,
          input: {
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: prompt.instanceId,
              instance: withProviderUsageAccess(
                config?.settings.providerInstances[prompt.instanceId],
                prompt.driver,
                access,
              ),
            },
          },
        });
      }),
    );
    setSaving(false);
    const failure = results.find(
      (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    );
    if (failure !== undefined && failure._tag === "Failure") {
      const cause = squashAtomCommandFailure(failure);
      setError(
        cause instanceof Error
          ? (errorDisplayMessage(cause, m) ?? cause.message)
          : gt("Could not save usage access"),
      );
    }
  };

  return (
    <SettingsSection
      title={gt("Show agent usage?")}
      footer={gt("You can change this for each agent in web or desktop Settings → Providers.")}
    >
      <View className="gap-1 px-4 pt-4">
        <Text className="text-sm text-foreground-muted">
          <T>T3 Code reads this from each agent to chart cost, tokens, and limits.</T>
        </Text>
      </View>
      {prompts.map((prompt) => {
        const key = promptKey(prompt);
        const snapshot = providersByEnvironment
          .get(prompt.environmentId)
          ?.find((provider) => provider.instanceId === prompt.instanceId);
        const label = resolveProviderInstanceDisplayName(
          snapshot ?? { instanceId: prompt.instanceId, driver: prompt.driver },
        );
        const allowed = !declined.has(key);
        return (
          <ListRowLayout
            key={key}
            label={label}
            description={
              showEnvironment
                ? gt("{environment} · {detail}", {
                    environment: prompt.environmentLabel,
                    detail: usageAccessReads(prompt.driver, gt),
                  })
                : usageAccessReads(prompt.driver, gt)
            }
            disabled={saving}
            accessory={
              <ThemedSwitch
                accessibilityLabel={label}
                disabled={saving}
                style={{ alignSelf: "center" }}
                value={allowed}
                onValueChange={(value) =>
                  setDeclined((current) => {
                    const next = new Set(current);
                    if (value) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              />
            }
          />
        );
      })}
      {error ? (
        <View className="px-4">
          <ErrorBanner message={error} />
        </View>
      ) : null}
      <View className="flex-row justify-end gap-2 px-4 pb-4 pt-1">
        <Button
          label={gt("Don't allow")}
          size="compact"
          disabled={saving}
          onPress={() => void answer(false)}
        />
        <Button
          label={gt("Allow")}
          tone="primary"
          size="compact"
          loading={saving}
          disabled={prompts.every((prompt) => declined.has(promptKey(prompt)))}
          onPress={() => void answer(true)}
        />
      </View>
    </SettingsSection>
  );
}
