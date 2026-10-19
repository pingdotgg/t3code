import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WEB_PROVIDER_DESCRIPTION,
  WEB_TOOL_API_KEYS,
  WEB_TOOL_PROVIDER_LABELS,
} from "@t3tools/client-runtime/web-tool-providers";
import { DEFAULT_WEB_TOOL_PROVIDER, WebToolProvider } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const PROVIDER_DESCRIPTIONS: Record<WebToolProvider, string> = {
  firecrawl: "Works without an API key on eligible networks.",
  exa: "Needs an Exa API key.",
  tavily: "Needs a Tavily API key.",
  builtin: "Each CLI keeps its own web search and fetch.",
};

export function SettingsWebRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "web provider update",
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  const providers = new Set(
    selectedTargets.map((target) => target.serverConfig.settings.web.provider),
  );
  const provider = providers.size === 1 ? [...providers][0]! : null;
  // The provider is environment-wide; a project selection cannot override it.
  const projectSelected = selectedProjectKey !== null;
  const disabled = pending || projectSelected || selectedTargets.length === 0;

  const choose = (next: WebToolProvider) => {
    if (disabled || next === provider) return;
    setPending(true);
    void Promise.allSettled(
      selectedTargets.map((target) =>
        updateSettings({
          environmentId: target.environmentId,
          input: { patch: { web: { provider: next } } },
        }),
      ),
    ).finally(() => setPending(false));
  };

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Web" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            <>
              <View className="gap-2">
                <SettingsSection
                  title="Web provider"
                  trailing={
                    provider === null && !pending ? (
                      <Text
                        accessibilityLabel="Selected environments use different web providers"
                        className="px-2 text-sm text-foreground-muted android:px-4"
                      >
                        Mixed
                      </Text>
                    ) : null
                  }
                >
                  {WebToolProvider.literals.map((value, index) => (
                    <SettingsChoiceRow
                      key={value}
                      label={WEB_TOOL_PROVIDER_LABELS[value]}
                      description={
                        value === DEFAULT_WEB_TOOL_PROVIDER
                          ? `Default. ${PROVIDER_DESCRIPTIONS[value]}`
                          : PROVIDER_DESCRIPTIONS[value]
                      }
                      selected={provider === value}
                      separated={index > 0}
                      disabled={disabled}
                      onPress={() => choose(value)}
                    />
                  ))}
                </SettingsSection>
                <Text className="px-2 text-sm text-foreground-muted">
                  {projectSelected
                    ? "Environment-wide setting. Select All projects to change it."
                    : WEB_PROVIDER_DESCRIPTION}
                </Text>
              </View>
              {provider !== DEFAULT_WEB_TOOL_PROVIDER && provider !== null && !projectSelected ? (
                <SettingsActionRow
                  icon="arrow.uturn.backward"
                  label={`Reset to ${WEB_TOOL_PROVIDER_LABELS[DEFAULT_WEB_TOOL_PROVIDER]}`}
                  disabled={disabled}
                  onPress={() => choose(DEFAULT_WEB_TOOL_PROVIDER)}
                />
              ) : null}
              {selectedTargets.map((target) =>
                target.serverConfig.settings.web.provider === "builtin" ? null : (
                  <WebApiKeySection
                    // Drafts belong to one environment and provider; switching must not carry them over.
                    key={`${target.environmentId}:${target.serverConfig.settings.web.provider}`}
                    target={target}
                    showEnvironment={selectedTargets.length > 1}
                  />
                ),
              )}
            </>
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/**
 * The selected provider's API key on one environment. Keys are write-only: the
 * server keeps them in its secret store and only reports whether one is set.
 */
function WebApiKeySection(props: {
  readonly target: SettingsTarget;
  readonly showEnvironment: boolean;
}) {
  const web = props.target.serverConfig.settings.web;
  const provider = web.provider === "builtin" ? "firecrawl" : web.provider;
  const info = WEB_TOOL_API_KEYS[provider];
  const label = WEB_TOOL_PROVIDER_LABELS[provider];
  const isSaved = web[info.field].length > 0;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "web provider API key update",
  });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (key: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId: props.target.environmentId,
        input: { patch: { web: { [info.field]: key } } },
      });
      if (result._tag === "Success") setDraft("");
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save the API key.");
      }
    } catch {
      setError("Could not save the API key.");
    } finally {
      setPending(false);
    }
  };

  return (
    <View className="gap-2">
      <SettingsSection
        title={
          props.showEnvironment ? `${label} API key · ${props.target.label}` : `${label} API key`
        }
      >
        <View className="gap-3 p-4">
          <Text className="text-sm leading-normal text-foreground-muted">{info.description}</Text>
          <AppTextInput
            accessibilityLabel={`${label} API key`}
            placeholder={isSaved ? "Stored secret, enter a new value to replace" : "Not set"}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => {
              if (draft.trim()) void save(draft.trim());
            }}
          />
          {error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </View>
        <View className="border-t border-border-subtle">
          <SettingsActionRow
            icon="checkmark"
            label="Save"
            disabled={pending || draft.trim() === ""}
            loading={pending}
            onPress={() => void save(draft.trim())}
          />
        </View>
        {isSaved ? (
          <View className="border-t border-border-subtle">
            <SettingsActionRow
              icon="trash"
              label="Remove"
              tone="danger"
              disabled={pending}
              onPress={() => void save("")}
            />
          </View>
        ) : null}
        <View className="border-t border-border-subtle">
          <SettingsActionRow
            icon="safari"
            label="Get an API key"
            onPress={() => void Linking.openURL(info.link)}
          />
        </View>
      </SettingsSection>
    </View>
  );
}
