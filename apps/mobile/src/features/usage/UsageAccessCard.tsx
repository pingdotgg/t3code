import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { usageAccessReadsLabel } from "@t3tools/client-runtime/state/usage-access";
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
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
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

const promptKey = (prompt: UsageAccessPrompt) => `${prompt.environmentId}\0${prompt.instanceId}`;

/** Asks before T3 reads an agent's usage files or sign-in. It stays until every agent is answered. */
export function UsageAccessCard({ prompts }: { readonly prompts: readonly UsageAccessPrompt[] }) {
  const gt = useGT();
  const messages = useMessages();
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
    const configs = prompts.map((prompt) =>
      appAtomRegistry.get(serverEnvironment.configValueAtom(prompt.environmentId)),
    );
    // A save rewrites the instance from its saved settings, so it waits until they have loaded.
    if (configs.some((config) => config === null)) {
      setError(gt("Could not save usage access"));
      return;
    }
    setSaving(true);
    setError(null);
    const results = await Promise.all(
      prompts.map((prompt, index) => {
        const access: ProviderUsageAccess =
          allowSelected && !declined.has(promptKey(prompt)) ? "allowed" : "denied";
        const config = configs[index];
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
    <View>
      <EmptyState
        variant="plain"
        title={gt("Show agent usage?")}
        detail={gt("T3 Code reads these from each agent, system-wide. Pick which agents to allow.")}
      />
      <View className="gap-5">
        <SettingsSection
          footer={gt("You can change this for each agent in web or desktop Settings → Providers.")}
        >
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
                leading={
                  <ProviderIcon provider={prompt.driver} iconUrl={snapshot?.iconUrl} size={20} />
                }
                label={label}
                description={
                  showEnvironment
                    ? gt("{environment} · {detail}", {
                        environment: prompt.environmentLabel,
                        detail: usageAccessReadsLabel(prompt.driver, messages),
                      })
                    : usageAccessReadsLabel(prompt.driver, messages)
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
        </SettingsSection>
        {error ? <ErrorBanner message={error} /> : null}
        <View className="gap-2.5">
          <Button
            label={gt("Allow")}
            tone="primary"
            fullWidth
            loading={saving}
            disabled={prompts.every((prompt) => declined.has(promptKey(prompt)))}
            onPress={() => void answer(true)}
          />
          <Button
            label={gt("Don't allow")}
            fullWidth
            disabled={saving}
            onPress={() => void answer(false)}
          />
        </View>
      </View>
    </View>
  );
}
