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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
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
import { useSearchableSetting } from "./settingsSearch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
} from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const GROUNDER_KINDS: ReadonlyArray<{
  readonly kind: Extract<ComputerGrounderKind, "openai-compatible" | "systemone">;
  readonly label: string;
}> = [
  // oxlint-disable-next-line t3code/no-untranslated-copy -- API format name
  { kind: "openai-compatible", label: "OpenAI-compatible" },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
  { kind: "systemone", label: "System One" },
];

const JEV_KEYS_URL = "https://console.typesafe.ai/keys";

const workingLimit = formatDuration(COMPUTER_LIMITS.timeoutMs);
const approvalLimit = formatDuration(COMPUTER_LIMITS.approvalTimeoutMs);

function hostPlatformLabel(host: ComputerHostView): string {
  const parts = [host.platform, host.device].filter((part) => part.trim().length > 0);
  const known = parts.join(" · ");
  return known.length > 0 ? known : host.name;
}

/** What a host can do, in the order that decides whether it is usable at all. */
function hostAbility(
  host: ComputerHostView,
  resolve: MessageResolver = m,
): { readonly text: string; readonly ok: boolean } {
  if (host.accessibility !== true) {
    return { text: resolve(msg("Needs Accessibility permission on that Mac")), ok: false };
  }
  if (host.computerUse !== true) return { text: resolve(msg("Fixed controls only")), ok: true };
  if (host.screenRecording !== true) {
    return {
      text: resolve(msg("Works from accessibility; screen reading is off")),
      ok: true,
    };
  }
  return { text: resolve(msg("Ready", { $context: "computer host status" })), ok: true };
}

/**
 * The decision endpoint and the audit log belong to one server, so they follow the page's picker:
 * exactly one selected environment, and not a project scope that would write it environment-wide.
 */
function useSoleEnvironment() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" && scope.kind !== "all") return null;
  if (scope.environmentIds.length !== 1) return null;
  return environment?.environmentId === scope.environmentIds[0] ? environment : null;
}

function AgentComputerUseSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
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
          ? gt(
              "Allow agents in this project to use a connected computer. Applies when the agent session next starts.",
            )
          : gt("Allow agents to use a connected computer. Projects can override it.")
      }
      resetAction={
        settings.enableAgentComputerUse !== DEFAULT_SERVER_SETTINGS.enableAgentComputerUse ? (
          <SettingResetButton
            ariaLabel={gt("Reset agent computer use to default")}
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
          aria-label={gt("Agent computer use")}
          checked={settings.enableAgentComputerUse}
          onCheckedChange={(enabled) => updateSettings({ enableAgentComputerUse: enabled })}
        />
      }
    />
  );
}

function ApprovalsSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const asking = settings.computerApprovals === "ask";
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const behavior = asking
    ? gt(
        "A step that types, sends, buys or deletes waits for your tap, bound to that exact action. Fixed controls do not ask.",
      )
    : gt(
        "Steps run as soon as the agent asks. Every consequential step is still in the activity log, and Stop still ends a task from anywhere.",
      );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["computerApprovals"]}
      {...searchableSetting("computer-approvals")}
      title={gt("Ask before consequential actions")}
      description={
        isProjectScope
          ? gt("{behavior} Applies from the next step, in this project.", { behavior })
          : gt("{behavior} Projects can override it.", { behavior })
      }
      status={
        asking ? null : (
          <span className="flex items-center gap-1 text-warning-foreground">
            <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
            <T>Approvals off</T>
          </span>
        )
      }
      control={
        <ScopedSwitch
          settingKeys={["computerApprovals"]}
          aria-label={gt("Ask before consequential actions")}
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
  const gt = useGT();
  const m = useMessages();
  const ability = hostAbility(host, m);
  const controls = host.controls.length === 0 ? gt("no fixed controls") : host.controls.join(", ");
  return (
    <SettingsRow
      title={host.name}
      description={
        <span className="grid gap-0.5">
          <span>
            {hostPlatformLabel(host)} · {environmentLabel}
          </span>
          <span className={ability.ok ? undefined : "text-warning-foreground"}>{ability.text}</span>
          <span>
            <T>
              Fixed controls: <Var>{controls}</Var>
            </T>
          </span>
        </span>
      }
      control={
        host.busyTaskId === null ? null : (
          <span className="text-xs text-muted-foreground">
            <T>Running a task</T>
          </span>
        )
      }
    />
  );
}

function ComputersSection() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { environment, scope } = useSettingsScope();
  const selected = new Set(scope.environmentIds);
  const hosts = useComputerHosts().filter((entry) => selected.has(entry.environmentId));

  return (
    <SettingsSection id="computer-use-computers" title={gt("Computers")}>
      <SettingsRow
        {...searchableSetting("computer-hosts")}
        title={gt("Connected computers")}
        description={
          hosts.length === 0
            ? gt(
                "None. Open Ada on the computer you want to use and allow this environment there; a computer is available only while Ada is open on it.",
              )
            : undefined
        }
        control={
          <span className="text-xs text-muted-foreground">
            <T>
              <Var>{hosts.length}</Var> connected
            </T>
          </span>
        }
      />
      {hosts.map((entry) => (
        <HostRow
          key={`${entry.environmentId}:${entry.host.hostId}`}
          host={entry.host}
          environmentLabel={entry.environmentLabel}
        />
      ))}
      <SettingsRow
        title={gt("Limits")}
        description={gt(
          "{steps} steps and {working} of working time per task, one task per computer. A tap waits {approval}; waiting for a tap or for the agent does not count as working time.",
          { steps: COMPUTER_LIMITS.maxSteps, working: workingLimit, approval: approvalLimit },
        )}
      />
      {isElectron ? (
        <ComputerPermissionRows environmentId={environment?.environmentId ?? null} />
      ) : null}
    </SettingsSection>
  );
}

function emptyGrounder(): ComputerGrounderConfig {
  return { kind: "jev", baseUrl: "", model: "", apiKey: "" };
}

/** The Jev preset stores only its key; a custom endpoint needs its own URL and model. */
function grounderToSave(values: ComputerGrounderConfig): ComputerGrounderConfig | null {
  if (values.kind === "jev") {
    // Without a key the agent plans each step, so there is nothing to store.
    if (typeof values.apiKey === "string" && values.apiKey.length === 0) return null;
    return { kind: "jev", baseUrl: "", model: "", apiKey: values.apiKey };
  }
  const baseUrl = values.baseUrl.trim();
  const model = values.model.trim();
  if (baseUrl.length === 0 || model.length === 0) return null;
  return { kind: values.kind, baseUrl, model, apiKey: values.apiKey };
}

function GrounderForm({
  environmentId,
  shared,
}: {
  readonly environmentId: EnvironmentId;
  readonly shared: boolean;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.computerGrounder);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const gt = useGT();
  const [draft, setDraft] = useState<Partial<ComputerGrounderConfig> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const values: ComputerGrounderConfig =
    draft === null ? (saved ?? emptyGrounder()) : { ...(saved ?? emptyGrounder()), ...draft };
  const jev = values.kind === "jev";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    const patch: ServerSettingsPatch = { computerGrounder: grounderToSave(values) };
    await updateSettings(patch, {
      onSaved: () => {
        setDraft(null);
        setMessage(gt("Saved. Applies from the next step."));
      },
      onFailed: () => setMessage(null),
    });
    setSaving(false);
  };

  const apiKeyField = (
    <div className="grid gap-1.5">
      <Label htmlFor="computer-grounder-key">
        <T>API key</T>
      </Label>
      <SecretInput
        id="computer-grounder-key"
        size="sm"
        configured={typeof values.apiKey === "string" && values.apiKey.length > 0}
        value={typeof values.apiKey === "string" ? values.apiKey : ""}
        onCommit={(apiKey) => setDraft((previous) => ({ ...previous, apiKey }))}
      />
    </div>
  );

  return (
    <SettingsSection id="computer-use-grounder" title={gt("Decision endpoint")}>
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-xs text-muted-foreground">
          <T>
            Optional. A decision endpoint answers a click the policy cannot settle; without one the
            agent answers in <code className="font-mono">computer_use</code>. It sees control labels
            and up to 1,500 characters of visible text, and never writes text: only the text a task
            was started with is ever typed.
          </T>
          {shared ? (
            <>
              {" "}
              <T>It applies to all your devices, and clearing it clears it everywhere.</T>
            </>
          ) : null}
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="computer-grounder-provider">
            <T>Provider</T>
          </Label>
          <Select
            value={jev ? "jev" : "custom"}
            onValueChange={(provider) =>
              setDraft((previous) => ({
                ...previous,
                kind: provider === "jev" ? "jev" : "openai-compatible",
                // A stored key belongs to its provider's host and must not follow to another.
                apiKey:
                  saved !== null && (saved.kind === "jev") === (provider === "jev")
                    ? saved.apiKey
                    : "",
              }))
            }
          >
            <SelectTrigger id="computer-grounder-provider" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product name */}
              <SelectItem value="jev">Jev (TypeSafe)</SelectItem>
              <SelectItem value="custom">
                <T context="custom provider option">Custom</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
        {jev ? (
          <>
            {apiKeyField}
            <p className="text-xs text-muted-foreground">
              <T>
                Jev is TypeSafe's System One model. Get a key from the{" "}
                <a
                  href={JEV_KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  TypeSafe console
                </a>
                ; without one the agent plans each step.
              </T>
            </p>
          </>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="computer-grounder-kind">
                <T context="endpoint API kind">Kind</T>
              </Label>
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
              <Label htmlFor="computer-grounder-url">
                <T>Base URL</T>
              </Label>
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
              <Label htmlFor="computer-grounder-model">
                <T context="AI model">Model</T>
              </Label>
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
            {apiKeyField}
          </>
        )}
        <div className="flex items-center justify-end gap-2">
          {message === null ? null : (
            <span className="text-xs text-muted-foreground">{message}</span>
          )}
          <Button type="submit" size="sm" disabled={saving || draft === null}>
            {saving ? gt("Saving...") : gt("Save", { $context: "button, saves the endpoint" })}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function GrounderSection() {
  const gt = useGT();
  const environment = useSoleEnvironment();
  if (environment === null) {
    return (
      <SettingsSection id="computer-use-grounder" title={gt("Decision endpoint")}>
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>
            Select one environment above to set the endpoint that answers a click computer use
            cannot settle. It applies to all your devices.
          </T>
        </p>
      </SettingsSection>
    );
  }
  if (environment.serverConfig?.environment.capabilities.computerUse !== true) {
    return (
      <SettingsSection id="computer-use-grounder" title={gt("Decision endpoint")}>
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>
            This environment's server does not offer computer use yet. Update it to configure a
            decision endpoint.
          </T>
        </p>
      </SettingsSection>
    );
  }
  return (
    <GrounderForm
      environmentId={environment.environmentId}
      shared={environment.serverConfig.environment.capabilities.computerGrounderSync === true}
    />
  );
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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const environment = useSoleEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const [limit, setLimit] = useState(50);
  const supported = environment?.serverConfig?.environment.capabilities.computerUse === true;
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
          <T>
            Every task, grant, approval and outcome, newest last. Typed text is recorded as its
            length and a digest, never the text.
          </T>
        </p>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label={gt("Refresh activity")}
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {query.error !== null ? (
        <p className="px-3 pb-2 text-xs text-destructive sm:px-4">{query.error}</p>
      ) : lines.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
          {supported
            ? gt("Nothing yet.")
            : gt("Select one environment above to read what computer use did there.")}
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
            <T>Show older</T>
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
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        <T>
          Computer use is in early testing and may make mistakes. Keep approvals on for anything
          important.
        </T>
      </p>
      <SettingsSection id="computer-use-agents" title={gt("Agent access")}>
        <AgentComputerUseSetting />
        <ApprovalsSetting />
      </SettingsSection>
      <ComputersSection />
      <GrounderSection />
      <AuditSection />
    </SettingsPageContainer>
  );
}
