import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CONTEXT_RESTART_ABOVE_TOKENS,
  MIN_CONTEXT_RESTART_ABOVE_TOKENS,
} from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";

import { useEnvironments } from "~/state/environments";
import { ExternalHistoryButton } from "../externalHistory/ExternalHistoryDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ModelEvaluationSettings } from "./ModelEvaluationSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  scopedAssistedLearningUnavailableReason,
  scopedMemoryCurationUnavailableReason,
} from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { hasInferenceProxyEnvironment, searchableSetting } from "./settingsSearch";
import { SkillsLibraryRows } from "./SkillsLibrarySettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork-only feature preferences, grouped so they are easy to find. */
export function ZackSettings() {
  return (
    <SettingsSection id="zack" title="Zack" variant="plain">
      <div className="space-y-6">
        <SettingsSection title="Holographic memory">
          <AssistedLearningRow />
          <MemoryCurationRow />
        </SettingsSection>
        <SettingsSection title="LCM (lossless context management)">
          <ConversationSummariesRow />
          <ContextRestartRow />
          <ExternalHistoryRow />
        </SettingsSection>
        <SettingsSection title="Skills">
          <PstackRow />
          <SkillsLibraryRows />
        </SettingsSection>
        <SettingsSection title="Thread conversations">
          <GroupConversationsRow />
        </SettingsSection>
        <SettingsSection title="Agent tools and accounts">
          <AgentGitHubReadGateRow />
          <InferenceAccountsRow />
        </SettingsSection>
        <ModelEvaluationSettings />
      </div>
    </SettingsSection>
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
          ? "Completed runs in this project are grouped into background learning batches. Your text generation model saves up to three cited facts per batch; eligible batches use at most one model call."
          : "Completed runs are grouped into background learning batches. Your text generation model saves up to three cited facts per batch; eligible batches use at most one model call. Projects can override it.")
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

function MemoryCurationRow() {
  const { targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const unavailableReason = scopedMemoryCurationUnavailableReason(
    connectedEnvironments.filter((environment) =>
      targets.some((target) => target.environmentId === environment.environmentId),
    ),
  );
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableMemoryCuration"]}
      {...searchableSetting("memory-curation")}
      description={
        unavailableReason ??
        "Review saved agent memories within each project. Background batches set aside task notes and link duplicates or replaced decisions. Original content and review reasons remain available, and you can restore a memory. Uses your text generation model."
      }
      resetAction={
        unavailableReason === null && !settings.enableMemoryCuration ? (
          <SettingResetButton
            label="memory curation"
            tooltip="Reset memory curation to on"
            onClick={() => updateSettings({ enableMemoryCuration: true })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableMemoryCuration"]}
          aria-label="Curate project memories"
          disabled={unavailableReason !== null}
          checked={settings.enableMemoryCuration}
          onCheckedChange={(enabled) => updateSettings({ enableMemoryCuration: enabled })}
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
          ? "After turns complete in this project, your text model summarizes older messages so switches and forks keep the gist of history that no longer fits. Each summary costs one model call."
          : "After turns complete, your text model summarizes older messages so switches and forks keep the gist of history that no longer fits. Each summary costs one model call. Projects can override it."
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

function ContextRestartRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["contextRestartAboveTokens"]);
  const current = settings.contextRestartAboveTokens;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["contextRestartAboveTokens"]}
      mixed={mixed}
      {...searchableSetting("context-restart")}
      description="When a Codex thread's context reaches this many tokens, continue in a fresh conversation built from summaries and the newest messages. Needs summaries. Empty is off."
      resetAction={
        current !== null ? (
          <SettingResetButton
            label="restart from summaries"
            tooltip="Reset restart from summaries to off"
            onClick={() => updateSettings({ contextRestartAboveTokens: null })}
          />
        ) : null
      }
      control={
        <Input
          key={mixed ? "mixed" : String(current)}
          type="number"
          inputMode="numeric"
          min={MIN_CONTEXT_RESTART_ABOVE_TOKENS}
          max={MAX_CONTEXT_RESTART_ABOVE_TOKENS}
          step={10_000}
          defaultValue={mixed || current === null ? "" : current}
          placeholder={mixed ? "Mixed" : "Off"}
          aria-label="Restart above tokens"
          onBlur={(event) => {
            const typed = event.target.value.trim();
            if (mixed && typed === "") return;
            const next =
              typed === ""
                ? null
                : Math.min(
                    MAX_CONTEXT_RESTART_ABOVE_TOKENS,
                    Math.max(MIN_CONTEXT_RESTART_ABOVE_TOKENS, Math.round(Number(typed))),
                  );
            if (next !== null && !Number.isFinite(next)) return;
            if (next !== current) updateSettings({ contextRestartAboveTokens: next });
          }}
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
      description="Automatically find and search agent conversations on an environment. Sources stay in place."
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

function GroupConversationsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["groupConversationsEnabled"]}
      {...searchableSetting("group-conversations")}
      description="Invite models from any provider into one thread. Talk to all of them or one with @, and let them answer each other. Off stops new invites; a running group keeps its End and Remove controls."
      resetAction={
        settings.groupConversationsEnabled !==
        DEFAULT_UNIFIED_SETTINGS.groupConversationsEnabled ? (
          <SettingResetButton
            label="group conversations"
            onClick={() =>
              updateSettings({
                groupConversationsEnabled: DEFAULT_UNIFIED_SETTINGS.groupConversationsEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["groupConversationsEnabled"]}
          checked={settings.groupConversationsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ groupConversationsEnabled: Boolean(checked) })
          }
          aria-label="Group conversations"
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

function InferenceAccountsRow() {
  const { environments } = useEnvironments();
  if (!hasInferenceProxyEnvironment(environments)) return null;
  return (
    <SettingsRow
      title="Inference accounts"
      description="Host provider accounts and route inference through an environment over Tailscale or your trusted LAN."
      control={
        <Button size="sm" variant="outline" render={<Link to="/settings/inference" />}>
          Open
        </Button>
      }
    />
  );
}
