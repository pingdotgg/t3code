import { DEFAULT_SERVER_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";

import { useEnvironments } from "~/state/environments";
import { ExternalHistoryButton } from "../externalHistory/ExternalHistoryDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ModelEvaluationSettings } from "./ModelEvaluationSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { scopedAssistedLearningUnavailableReason } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { hasProviderPoolsEnvironment, searchableSetting } from "./settingsSearch";
import { SkillsLibraryRows } from "./SkillsLibrarySettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork-only feature preferences, grouped so they are easy to find. */
export function ZackSettings() {
  return (
    <>
      <SettingsSection id="zack" title="Zack">
        <AssistedLearningRow />
        <ConversationSummariesRow />
        <ExternalHistoryRow />
        <PstackRow />
        <SkillsLibraryRows />
        <AgentGitHubReadGateRow />
        <ThreadSplitRows />
        <AccountPoolsRow />
      </SettingsSection>
      <ModelEvaluationSettings />
    </>
  );
}

function useIsProjectScope() {
  const { scope } = useSettingsScope();
  return scope.kind === "project" || scope.kind === "checkout";
}

function AssistedLearningRow() {
  const { target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["enableAssistedLearning"]);
  const isProjectScope = useIsProjectScope();
  const unavailableReason = scopedAssistedLearningUnavailableReason(
    connectedEnvironments.filter(
      (environment) => environment.environmentId === target?.environmentId,
    ),
  );
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAssistedLearning"]}
      mixed={mixed}
      {...searchableSetting("assisted-learning")}
      description={
        unavailableReason ??
        (isProjectScope
          ? "After each run in this project, your text generation model saves up to three cited facts to Project memory. Each run costs one model call."
          : "After each run, your text generation model saves up to three cited facts to Project memory. Each run costs one model call. Projects can override it.")
      }
      resetAction={
        unavailableReason === null &&
        settings.enableAssistedLearning !== DEFAULT_SERVER_SETTINGS.enableAssistedLearning ? (
          <SettingResetButton
            label="automatic memory"
            tooltip="Reset automatic memory to on"
            onClick={() =>
              updateSettings({
                enableAssistedLearning: DEFAULT_SERVER_SETTINGS.enableAssistedLearning,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Save facts from finished runs"
          disabled={unavailableReason !== null}
          mixed={mixed}
          checked={mixed ? false : settings.enableAssistedLearning}
          onCheckedChange={(enabled) => updateSettings({ enableAssistedLearning: enabled })}
        />
      }
    />
  );
}

function ConversationSummariesRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["enableConversationSummaries"]);
  const isProjectScope = useIsProjectScope();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableConversationSummaries"]}
      mixed={mixed}
      {...searchableSetting("conversation-summaries")}
      description={
        isProjectScope
          ? "After turns complete in this project, your text generation model summarizes older messages so provider switches and forks keep the gist of history that no longer fits. Each summary costs one model call."
          : "After turns complete, your text generation model summarizes older messages so provider switches and forks keep the gist of history that no longer fits. Each summary costs one model call. Projects can override it."
      }
      resetAction={
        settings.enableConversationSummaries ? (
          <SettingResetButton
            label="conversation summaries"
            tooltip="Reset conversation summaries to off"
            onClick={() => updateSettings({ enableConversationSummaries: false })}
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Summarize older messages"
          mixed={mixed}
          checked={mixed ? false : settings.enableConversationSummaries}
          onCheckedChange={(enabled) => updateSettings({ enableConversationSummaries: enabled })}
        />
      }
    />
  );
}

function ExternalHistoryRow() {
  const { connectedEnvironments } = useSettingsScope();
  const isProjectScope = useIsProjectScope();
  if (
    isProjectScope ||
    !connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.externalHistory === 1,
    )
  ) {
    return null;
  }
  return (
    <SettingsRow
      {...searchableSetting("external-history")}
      description="Search provider-native conversations and ChatGPT export files on an environment. Sources are read in place without importing them as T3 threads."
      control={
        <div className="flex flex-wrap gap-2">
          {connectedEnvironments.map((environment) => (
            <ExternalHistoryButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
            />
          ))}
        </div>
      }
    />
  );
}

function PstackRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["pstackEnabled"]}
      {...searchableSetting("pstack")}
      description="Offer Lauren Tan's pstack workflows as skills in every provider. Run $pstack:setup-pstack once to choose models."
      resetAction={
        settings.pstackEnabled !== DEFAULT_UNIFIED_SETTINGS.pstackEnabled ? (
          <SettingResetButton
            label="pstack"
            onClick={() =>
              updateSettings({ pstackEnabled: DEFAULT_UNIFIED_SETTINGS.pstackEnabled })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["pstackEnabled"]}
          checked={settings.pstackEnabled}
          onCheckedChange={(checked) => updateSettings({ pstackEnabled: Boolean(checked) })}
          aria-label="pstack"
        />
      }
    />
  );
}

function AgentGitHubReadGateRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentGitHubReadGate"]}
      {...searchableSetting("agent-github-reads")}
      description="T3 sends supported gh reads from local agent sessions to its shared PR tools. Turn this off to allow direct reads. The change applies when an agent session next starts."
      resetAction={
        settings.enableAgentGitHubReadGate !== DEFAULT_SERVER_SETTINGS.enableAgentGitHubReadGate ? (
          <SettingResetButton
            label="default GitHub read gate"
            onClick={() =>
              updateSettings({
                enableAgentGitHubReadGate: DEFAULT_SERVER_SETTINGS.enableAgentGitHubReadGate,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentGitHubReadGate"]}
          aria-label="Send agents' GitHub reads through T3"
          checked={settings.enableAgentGitHubReadGate}
          onCheckedChange={(enabled) => updateSettings({ enableAgentGitHubReadGate: enabled })}
        />
      }
    />
  );
}

function ThreadSplitRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("thread-split-suggestions")}
        settingKeys={["threadSplitSuggestionsEnabled"]}
        description="Suggest a fresh thread when a draft appears independent of this conversation. Suggestions never send messages or split threads automatically. Requires a local decision model on the connected server."
        control={
          <ScopedSwitch
            settingKeys={["threadSplitSuggestionsEnabled"]}
            checked={settings.threadSplitSuggestionsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ threadSplitSuggestionsEnabled: Boolean(checked) })
            }
            aria-label="Suggest new threads"
          />
        }
      />
      <SettingsRow
        serverScoped
        title="Local decision model endpoint"
        settingKeys={["threadSplitModelEndpoint"]}
        description="Loopback HTTP endpoint on this server for a Jev-compatible decision model. Leave empty to disable inference."
        control={
          <Input
            key={settings.threadSplitModelEndpoint}
            defaultValue={settings.threadSplitModelEndpoint}
            placeholder="http://127.0.0.1:8080"
            aria-label="Local decision model endpoint"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== settings.threadSplitModelEndpoint)
                updateSettings({ threadSplitModelEndpoint: value });
            }}
          />
        }
      />
    </>
  );
}

/** Pools stay on their own page because they edit one environment at a time. */
function AccountPoolsRow() {
  const { environments } = useEnvironments();
  if (!hasProviderPoolsEnvironment(environments)) return null;
  return (
    <SettingsRow
      title="Account pools"
      description="Pool accounts of the same provider so turns run on an account that still has quota."
      control={
        <Button size="sm" variant="outline" render={<Link to="/settings/account-pools" />}>
          Open
        </Button>
      }
    />
  );
}
