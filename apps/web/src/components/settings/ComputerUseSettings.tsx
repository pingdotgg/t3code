import {
  COMPUTER_LIMITS,
  DEFAULT_SERVER_SETTINGS,
  type ComputerGrounderConfig,
  type ComputerGrounderKind,
  type ComputerHostView,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { isElectron } from "../../env";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { computerEnvironment, useComputerHosts } from "../../state/computer";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ComputerPermissionRows } from "./ComputerPermissionRows";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { searchableSetting } from "./settingsSearch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
} from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const GROUNDER_KINDS: ReadonlyArray<{
  readonly kind: ComputerGrounderKind;
  readonly label: string;
}> = [
  { kind: "openai-compatible", label: "OpenAI-compatible" },
  { kind: "systemone", label: "System One" },
];

const stepLimit = `${COMPUTER_LIMITS.maxSteps} steps`;
const workingLimit = formatDuration(COMPUTER_LIMITS.timeoutMs);
const approvalLimit = formatDuration(COMPUTER_LIMITS.approvalTimeoutMs);

function hostPlatformLabel(host: ComputerHostView): string {
  const parts = [host.platform, host.device].filter((part) => part.trim().length > 0);
  const known = parts.join(" · ");
  return known.length > 0 ? known : host.name;
}

/** What a host can do, in the order that decides whether it is usable at all. */
function hostAbility(host: ComputerHostView): { readonly text: string; readonly ok: boolean } {
  if (host.accessibility !== true) {
    return { text: "Needs Accessibility permission on that Mac", ok: false };
  }
  if (host.computerUse !== true) return { text: "Fixed controls only", ok: true };
  if (host.screenRecording !== true) {
    return { text: "Works from accessibility; screen reading is off", ok: true };
  }
  return { text: "Ready", ok: true };
}

/** The grounder and the audit log belong to one server, so they need exactly one selected. */
function isSingleEnvironmentScope(scopeKind: string): boolean {
  return scopeKind === "environment";
}

function AgentComputerUseSetting() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentComputerUse"]}
      {...searchableSetting("agent-computer-use")}
      description={
        isProjectScope
          ? "Allow agents in this project to use a connected computer. Applies when the agent session next starts."
          : "Allow agents to use a connected computer. Projects can override it."
      }
      resetAction={
        settings.enableAgentComputerUse !== DEFAULT_SERVER_SETTINGS.enableAgentComputerUse ? (
          <SettingResetButton
            label="default computer use"
            onClick={() =>
              updateSettings({
                enableAgentComputerUse: DEFAULT_SERVER_SETTINGS.enableAgentComputerUse,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentComputerUse"]}
          aria-label="Agent computer use"
          checked={settings.enableAgentComputerUse}
          onCheckedChange={(enabled) => updateSettings({ enableAgentComputerUse: enabled })}
        />
      }
    />
  );
}

function ApprovalsSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const asking = settings.computerApprovals === "ask";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["computerApprovals"]}
      {...searchableSetting("computer-approvals")}
      title="Ask before consequential actions"
      description={
        asking
          ? "A step that types, sends, buys or deletes waits for your tap, bound to that exact action. Fixed controls do not ask."
          : "Steps run as soon as the agent asks. Every consequential step is still in the activity log, and Stop still ends a task from anywhere."
      }
      status={
        asking ? null : (
          <span className="flex items-center gap-1 text-warning-foreground">
            <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
            Approvals off
          </span>
        )
      }
      control={
        <ScopedSwitch
          settingKeys={["computerApprovals"]}
          aria-label="Ask before consequential actions"
          checked={asking}
          onCheckedChange={(ask) => updateSettings({ computerApprovals: ask ? "ask" : "skip" })}
        />
      }
    />
  );
}

function HostRow({
  host,
  environmentLabel,
}: {
  readonly host: ComputerHostView;
  readonly environmentLabel: string;
}) {
  const ability = hostAbility(host);
  const controls = host.controls.length === 0 ? "no fixed controls" : host.controls.join(", ");
  return (
    <SettingsRow
      title={host.name}
      description={
        <span className="grid gap-0.5">
          <span>
            {hostPlatformLabel(host)} · {environmentLabel}
          </span>
          <span className={ability.ok ? undefined : "text-warning-foreground"}>{ability.text}</span>
          <span>Fixed controls: {controls}</span>
        </span>
      }
      control={
        host.busyTaskId === null ? null : (
          <span className="text-xs text-muted-foreground">Running a task</span>
        )
      }
    />
  );
}

function ComputersSection() {
  const { environment, scope } = useSettingsScope();
  const selected = new Set(scope.environmentIds);
  const hosts = useComputerHosts().filter((entry) => selected.has(entry.environmentId));

  return (
    <SettingsSection id="computer-use-computers" title="Computers">
      <SettingsRow
        {...searchableSetting("computer-hosts")}
        title="Connected computers"
        description={
          hosts.length === 0
            ? "None. Open Ada on the computer you want to use and allow this environment there; a computer is available only while Ada is open on it."
            : undefined
        }
        control={<span className="text-xs text-muted-foreground">{hosts.length} connected</span>}
      />
      {hosts.map((entry) => (
        <HostRow
          key={`${entry.environmentId}:${entry.host.hostId}`}
          host={entry.host}
          environmentLabel={entry.environmentLabel}
        />
      ))}
      <SettingsRow
        title="Limits"
        description={`${stepLimit} and ${workingLimit} of working time per task, one task per computer. A tap waits ${approvalLimit}; waiting for a tap or for the agent does not count as working time.`}
      />
      {/* Desktop-only: offering this Mac and the macOS grants the helper needs (Phase D). */}
      {isElectron ? (
        <ComputerPermissionRows environmentId={environment?.environmentId ?? null} />
      ) : null}
    </SettingsSection>
  );
}

function emptyGrounder(): ComputerGrounderConfig {
  return { kind: "openai-compatible", baseUrl: "", model: "", apiKey: "" };
}

function GrounderForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.computerGrounder);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<Partial<ComputerGrounderConfig> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const values: ComputerGrounderConfig =
    draft === null ? (saved ?? emptyGrounder()) : { ...(saved ?? emptyGrounder()), ...draft };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    const patch: ServerSettingsPatch = {
      computerGrounder:
        values.baseUrl.trim().length === 0 || values.model.trim().length === 0 ? null : values,
    };
    await updateSettings(patch, {
      onSaved: () => {
        setDraft(null);
        setMessage("Saved. Applies from the next step.");
      },
      onFailed: () => setMessage(null),
    });
    setSaving(false);
  };

  return (
    <SettingsSection id="computer-use-grounder" title="Decision endpoint">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-xs text-muted-foreground">
          Optional. When set, this endpoint answers a click the policy cannot settle. Empty, the
          agent answers in <code className="font-mono">computer_use</code>. It sees control labels
          and up to 1,500 characters of visible text, and never writes text: only the text a task
          was started with is ever typed.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="computer-grounder-kind">Kind</Label>
          <Select
            value={values.kind}
            onValueChange={(kind) =>
              setDraft((previous) => ({ ...previous, kind: kind as ComputerGrounderKind }))
            }
          >
            <SelectTrigger id="computer-grounder-kind" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {GROUNDER_KINDS.map((option) => (
                <SelectItem key={option.kind} value={option.kind}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="computer-grounder-url">Base URL</Label>
          <Input
            id="computer-grounder-url"
            size="sm"
            type="url"
            placeholder="http://localhost:11434/v1"
            spellCheck={false}
            value={values.baseUrl}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="computer-grounder-model">Model</Label>
          <Input
            id="computer-grounder-model"
            size="sm"
            spellCheck={false}
            placeholder="qwen3-vl:8b"
            value={values.model}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, model: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="computer-grounder-key">API key</Label>
          <SecretInput
            id="computer-grounder-key"
            size="sm"
            configured={typeof values.apiKey === "string" && values.apiKey.length > 0}
            value={typeof values.apiKey === "string" ? values.apiKey : ""}
            onCommit={(apiKey) => setDraft((previous) => ({ ...previous, apiKey }))}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          {message === null ? null : (
            <span className="text-xs text-muted-foreground">{message}</span>
          )}
          <Button type="submit" size="sm" disabled={saving || draft === null}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function GrounderSection() {
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const supported =
    environment?.serverConfig?.environment.capabilities.computerUse === true &&
    isSingleEnvironmentScope(scope.kind);

  if (!supported || environmentId === null) {
    return (
      <SettingsSection id="computer-use-grounder" title="Decision endpoint">
        <SettingsScopeNotice target="environment" inline>
          Choose one environment to configure its computer-use decision endpoint.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <GrounderForm environmentId={environmentId} />;
}

/** One audit line: the event, then the few fields a person needs to read it. */
function AuditLine({ line }: { readonly line: Readonly<Record<string, unknown>> }) {
  const ts = typeof line.ts === "number" ? new Date(line.ts).toISOString() : null;
  const event = typeof line.event === "string" ? line.event : "unknown";
  const goal = typeof line.goal === "string" ? line.goal : null;
  const app = typeof line.app === "string" ? line.app : null;
  const action = line.action as { readonly kind?: unknown; readonly label?: unknown } | undefined;
  const kind = typeof action?.kind === "string" ? action.kind : null;
  const label = typeof action?.label === "string" ? action.label : null;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 font-mono text-2xs sm:px-4">
      {ts === null ? null : (
        <span className="shrink-0 text-muted-foreground">{formatRelativeTimeLabel(ts)}</span>
      )}
      <span className="shrink-0 font-medium">{event}</span>
      {kind === null ? null : <span className="shrink-0 text-muted-foreground">{kind}</span>}
      {label === null ? null : <span className="min-w-0 truncate">{label}</span>}
      {app === null ? null : <span className="shrink-0 text-muted-foreground">{app}</span>}
      {goal === null ? null : <span className="min-w-0 truncate">{goal}</span>}
    </div>
  );
}

function AuditSection() {
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const [limit, setLimit] = useState(50);
  const supported =
    environment?.serverConfig?.environment.capabilities.computerUse === true &&
    isSingleEnvironmentScope(scope.kind);
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? computerEnvironment.audit({ environmentId, input: { limit } })
      : null,
  );
  const lines = query.data ?? [];

  return (
    <SettingsSection {...searchableSetting("computer-audit")}>
      <div className="flex items-start justify-between gap-3 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <p>
          Every task, grant, approval and outcome, newest last. Typed text is recorded as its length
          and a digest, never the text.
        </p>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label="Refresh activity"
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {query.error !== null ? (
        <p className="px-3 pb-2 text-xs text-destructive sm:px-4">{query.error}</p>
      ) : lines.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
          {supported ? "Nothing yet." : "Choose one environment to read its activity."}
        </p>
      ) : (
        <div className="max-h-80 overflow-auto border-t border-border/50">
          {lines.map((line) => (
            <AuditLine key={JSON.stringify(line)} line={line} />
          ))}
        </div>
      )}
      {lines.length > 0 && lines.length >= limit ? (
        <div className="px-3 pb-2 sm:px-4">
          <Button variant="link" size="xs" onClick={() => setLimit((current) => current + 50)}>
            Show older
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Settings → Computer use: what agents may do on a computer, which computers this environment
 * can use, who answers a click, and what happened.
 */
export function ComputerUseSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="computer-use-agents" title="Agent access">
        <AgentComputerUseSetting />
        <ApprovalsSetting />
      </SettingsSection>
      <ComputersSection />
      <GrounderSection />
      <AuditSection />
    </SettingsPageContainer>
  );
}
