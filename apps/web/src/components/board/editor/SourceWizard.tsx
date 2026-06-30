"use client";

import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  compileAutoPullRule,
  decodeAutoPullRule,
  effectiveAutoPullRule,
  type AutoPullCriteria,
  type WorkSourceConnectionView,
} from "@t3tools/contracts/workSource";
import type { WorkflowSourceConfig } from "@t3tools/contracts/workSource";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { AutoPullCriteriaEditor } from "./AutoPullCriteriaEditor";
import {
  defaultAsanaSelector,
  defaultGithubSelector,
  defaultJiraSelector,
  decodeSelectorDraft,
  encodeSelector,
  type AsanaSelectorDraft,
  type GithubSelectorDraft,
  type JiraSelectorDraft,
  type SelectorDraft,
} from "./selectorDraft";
import type { WorkflowLaneEncoded } from "./WorkflowEditor";

// ─── types ─────────────────────────────────────────────────────────────────────

type Provider = "github" | "asana" | "jira";

type WizardStep = "provider" | "connection" | "scope" | "autoPull" | "lanes";

// ScopeDraft aliases selectorDraft.ts types so wizard-internal code stays readable.
type GithubScopeDraft = GithubSelectorDraft;
type AsanaScopeDraft = AsanaSelectorDraft;
type JiraScopeDraft = JiraSelectorDraft;
type ScopeDraft = SelectorDraft;

interface WizardDraft {
  /** Preserved on edit, freshly generated on create. */
  id: string;
  provider: Provider;
  connectionRef: string;
  scope: ScopeDraft;
  /** Whether the user has auto-pull toggled on. */
  autoPullOn: boolean;
  /** Structured criteria when autoPullOn and the rule is decodable. null = ALWAYS. */
  autoPullCriteria: AutoPullCriteria | null;
  /**
   * Preserved verbatim when the rule is an advanced (non-decodable) jsonLogic rule
   * that the user has not edited via the structured controls.
   */
  advancedRule: unknown | undefined;
  destinationLane: string;
  closedLane: string;
  /** Preserved from the original source on edit; undefined for new. */
  syncIntervalSec: number | undefined;
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function defaultGithubScope(): GithubScopeDraft {
  return defaultGithubSelector();
}

function defaultAsanaScope(): AsanaScopeDraft {
  return defaultAsanaSelector();
}

function defaultJiraScope(): JiraScopeDraft {
  return defaultJiraSelector();
}

function initDraftFromSource(source: WorkflowSourceConfig, _firstLane: string): WizardDraft {
  const effectiveRule = effectiveAutoPullRule(source);
  const autoPullOn = effectiveRule !== null;
  let autoPullCriteria: AutoPullCriteria | null = null;
  let advancedRule: unknown | undefined = undefined;

  if (autoPullOn && effectiveRule !== null) {
    const decoded = decodeAutoPullRule(effectiveRule);
    if (decoded !== null) {
      autoPullCriteria = decoded;
    } else {
      // Advanced rule the structured editor can't represent — preserve verbatim.
      advancedRule = effectiveRule;
    }
  }

  return {
    id: String(source.id),
    provider: source.provider as Provider,
    connectionRef: String(source.connectionRef),
    scope: decodeSelectorDraft(source),
    autoPullOn,
    autoPullCriteria,
    advancedRule,
    destinationLane: String(source.destinationLane),
    closedLane: String(source.closedLane),
    syncIntervalSec: source.syncIntervalSec,
  };
}

function newDraft(lanes: ReadonlyArray<WorkflowLaneEncoded>): WizardDraft {
  const firstLane = String(lanes[0]?.key ?? "");
  // closedLane must be a terminal lane (enforced by the board lint), so default
  // to the first terminal lane rather than the first lane.
  const firstTerminalLane = String(lanes.find((lane) => lane.terminal === true)?.key ?? firstLane);
  return {
    id: `source-${Date.now()}`,
    provider: "github",
    connectionRef: "",
    scope: { provider: "github", github: defaultGithubScope() },
    autoPullOn: false,
    autoPullCriteria: null,
    advancedRule: undefined,
    destinationLane: firstLane,
    closedLane: firstTerminalLane,
    syncIntervalSec: undefined,
  };
}

/** Build the final WorkflowSourceConfig from the wizard draft. */
function buildSourceFromDraft(draft: WizardDraft): WorkflowSourceConfig {
  // Determine the autoPull rule to persist:
  let autoPull: WorkflowSourceConfig["autoPull"] | undefined = undefined;
  if (draft.autoPullOn) {
    if (draft.advancedRule !== undefined) {
      // Advanced rule preserved verbatim (user did not switch to structured controls).
      autoPull = { rule: draft.advancedRule };
    } else {
      // Structured criteria: compile (null criteria → ALWAYS_RULE).
      autoPull = { rule: compileAutoPullRule(draft.autoPullCriteria ?? {}) };
    }
  }

  return {
    id: draft.id as WorkflowSourceConfig["id"],
    provider: draft.provider as WorkflowSourceConfig["provider"],
    connectionRef: draft.connectionRef as WorkflowSourceConfig["connectionRef"],
    selector: encodeSelector(draft.scope),
    destinationLane: draft.destinationLane as WorkflowSourceConfig["destinationLane"],
    closedLane: draft.closedLane as WorkflowSourceConfig["closedLane"],
    ...(draft.syncIntervalSec !== undefined ? { syncIntervalSec: draft.syncIntervalSec } : {}),
    ...(autoPull !== undefined ? { autoPull } : {}),
    // Omit `enabled` — migration to autoPull is persisted above.
  } as WorkflowSourceConfig;
}

/** Per-step validation error or null when the step is complete enough to advance. */
function stepValidationError(draft: WizardDraft, step: WizardStep): string | null {
  switch (step) {
    case "provider":
      return null;
    case "connection":
      return draft.connectionRef.trim() === "" ? "Select or create a connection." : null;
    case "scope":
      if (draft.scope.provider === "github") {
        const { owner, repo } = draft.scope.github;
        if (owner.trim() === "" || repo.trim() === "") return "Owner and repo are required.";
      } else if (draft.scope.provider === "jira") {
        if (draft.scope.jira.projectKey.trim() === "") return "Project key is required.";
      } else if (draft.scope.asana.projectGid.trim() === "") {
        return "Project GID is required.";
      }
      return null;
    case "autoPull":
    case "lanes":
      return null;
  }
}

// ─── step order ────────────────────────────────────────────────────────────────

const STEPS: WizardStep[] = ["provider", "connection", "scope", "autoPull", "lanes"];

function stepLabel(step: WizardStep): string {
  switch (step) {
    case "provider":
      return "Provider";
    case "connection":
      return "Connection";
    case "scope":
      return "Scope";
    case "autoPull":
      return "Auto-pull";
    case "lanes":
      return "Lanes";
  }
}

// ─── sub-components ────────────────────────────────────────────────────────────

function StepProvider({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: WizardDraft;
  readonly onChange: (next: WizardDraft) => void;
  readonly disabled: boolean;
}) {
  const handleChange = (provider: Provider) => {
    const scope: ScopeDraft =
      provider === "github"
        ? { provider: "github", github: defaultGithubScope() }
        : provider === "jira"
          ? { provider: "jira", jira: defaultJiraScope() }
          : { provider: "asana", asana: defaultAsanaScope() };
    onChange({ ...draft, provider, connectionRef: "", scope });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Choose the issue tracker to pull work from.</p>
      <div className="flex gap-3">
        {(["github", "asana", "jira"] as const).map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => handleChange(p)}
            className={[
              "flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors",
              draft.provider === p
                ? "border-primary bg-primary/8 text-primary"
                : "border-border bg-background text-foreground hover:border-primary/50",
            ].join(" ")}
          >
            {p === "github" ? "GitHub Issues" : p === "asana" ? "Asana Tasks" : "Jira"}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepConnection({
  draft,
  connections,
  connectionsLoading,
  connectionsError,
  createWorkSourceConnection,
  onChange,
  disabled,
}: {
  readonly draft: WizardDraft;
  readonly connections: ReadonlyArray<WorkSourceConnectionView>;
  readonly connectionsLoading: boolean;
  readonly connectionsError: string | null;
  readonly createWorkSourceConnection: SourceWizardCreateConnection | undefined;
  readonly onChange: (next: WizardDraft) => void;
  readonly disabled: boolean;
}) {
  const [addingNew, setAddingNew] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const providerConnections = connections.filter((c) => c.provider === draft.provider);

  const handleCreateNew = async () => {
    if (draft.provider === "jira") return;
    if (!createWorkSourceConnection) return;
    if (!newDisplayName.trim() || !newToken.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createWorkSourceConnection({
        provider: draft.provider,
        displayName: newDisplayName.trim(),
        token: newToken.trim(),
      });
      onChange({ ...draft, connectionRef: created.connectionRef });
      setAddingNew(false);
      setNewDisplayName("");
      setNewToken("");
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : "Failed to create connection.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Select an existing {draft.provider} connection or add a new one.
      </p>

      {connectionsLoading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Loading connections…
        </p>
      ) : connectionsError ? (
        <p className="text-xs text-destructive">{connectionsError}</p>
      ) : null}

      {providerConnections.length > 0 ? (
        <div className="space-y-1">
          {providerConnections.map((c) => (
            <button
              key={c.connectionRef}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...draft, connectionRef: c.connectionRef })}
              className={[
                "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
                draft.connectionRef === c.connectionRef
                  ? "border-primary bg-primary/8 text-primary"
                  : "border-border bg-background text-foreground hover:border-primary/50",
              ].join(" ")}
            >
              {c.displayName}
              <span className="ml-2 text-xs text-muted-foreground">{c.connectionRef}</span>
            </button>
          ))}
        </div>
      ) : (
        !connectionsLoading && (
          <p className="text-xs text-muted-foreground">No {draft.provider} connections yet.</p>
        )
      )}

      {draft.provider === "jira" ? (
        <p className="text-xs text-muted-foreground">
          Add a Jira connection in Settings, then select it here.
        </p>
      ) : createWorkSourceConnection ? (
        addingNew ? (
          <div className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
            <p className="text-xs font-semibold text-muted-foreground">
              New {draft.provider} connection
            </p>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <Input
                nativeInput
                value={newDisplayName}
                disabled={creating}
                placeholder={draft.provider === "github" ? "My GitHub PAT" : "My Asana PAT"}
                onChange={(e) => setNewDisplayName(e.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-foreground">Personal access token</span>
              <Input
                nativeInput
                type="password"
                value={newToken}
                disabled={creating}
                placeholder={draft.provider === "github" ? "ghp_…" : "Paste your token"}
                onChange={(e) => setNewToken(e.currentTarget.value)}
              />
            </label>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
            <div className="flex gap-2">
              <Button
                size="xs"
                disabled={creating || !newDisplayName.trim() || !newToken.trim()}
                onClick={() => void handleCreateNew()}
              >
                {creating ? (
                  <>
                    <Spinner className="size-3" />
                    Creating…
                  </>
                ) : (
                  "Create"
                )}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={creating}
                onClick={() => {
                  setAddingNew(false);
                  setNewDisplayName("");
                  setNewToken("");
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => setAddingNew(true)}
          >
            <PlusIcon className="size-3.5" />
            Create new connection
          </Button>
        )
      ) : null}
    </div>
  );
}

function StepScope({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: WizardDraft;
  readonly onChange: (next: WizardDraft) => void;
  readonly disabled: boolean;
}) {
  if (draft.scope.provider === "github") {
    const g = draft.scope.github;
    const updateG = (patch: Partial<GithubScopeDraft>) =>
      onChange({
        ...draft,
        scope: { provider: "github", github: { ...g, ...patch } },
      });
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Define which issues are visible in the import picker and eligible for auto-pull.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">Owner *</span>
            <Input
              nativeInput
              value={g.owner}
              disabled={disabled}
              placeholder="octocat"
              onChange={(e) => updateG({ owner: e.currentTarget.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">Repo *</span>
            <Input
              nativeInput
              value={g.repo}
              disabled={disabled}
              placeholder="my-repo"
              onChange={(e) => updateG({ repo: e.currentTarget.value })}
            />
          </label>
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-xs font-medium text-foreground">
              Labels filter (comma-separated, optional)
            </span>
            <Input
              nativeInput
              value={g.labels}
              disabled={disabled}
              placeholder="bug, enhancement"
              onChange={(e) => updateG({ labels: e.currentTarget.value })}
            />
            <span className="text-[11px] text-muted-foreground">
              Limits which issues are fetched from GitHub. Leave empty to fetch all.
            </span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">Assignee filter</span>
            <Input
              nativeInput
              value={g.assignee}
              disabled={disabled}
              placeholder="octocat"
              onChange={(e) => updateG({ assignee: e.currentTarget.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-foreground">State</span>
            <select
              className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={g.state}
              disabled={disabled}
              onChange={(e) => updateG({ state: e.currentTarget.value as "all" | "open" })}
            >
              <option value="all">all</option>
              <option value="open">open</option>
            </select>
          </label>
        </div>
      </div>
    );
  }

  // Jira
  if (draft.scope.provider === "jira") {
    const j = draft.scope.jira;
    const updateJ = (patch: Partial<JiraScopeDraft>) =>
      onChange({
        ...draft,
        scope: { provider: "jira", jira: { ...j, ...patch } },
      });
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Define which Jira issues are visible in the import picker and eligible for auto-pull.
        </p>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Project key *</span>
          <Input
            nativeInput
            value={j.projectKey}
            disabled={disabled}
            placeholder="ENG"
            onChange={(e) => updateJ({ projectKey: e.currentTarget.value })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">JQL (optional)</span>
          <Input
            nativeInput
            value={j.jql}
            disabled={disabled}
            placeholder="labels = backend"
            onChange={(e) => updateJ({ jql: e.currentTarget.value })}
          />
          <span className="text-[11px] text-muted-foreground">
            Optional — refine which issues are fetched.
          </span>
        </label>
      </div>
    );
  }

  // Asana
  const a = draft.scope.asana;
  const updateA = (patch: Partial<AsanaScopeDraft>) =>
    onChange({
      ...draft,
      scope: { provider: "asana", asana: { ...a, ...patch } },
    });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Define which Asana tasks are visible in the import picker.
      </p>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Project GID *</span>
        <Input
          nativeInput
          value={a.projectGid}
          disabled={disabled}
          placeholder="1234567890"
          onChange={(e) => updateA({ projectGid: e.currentTarget.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={a.includeCompleted}
          disabled={disabled}
          onChange={(e) => updateA({ includeCompleted: e.currentTarget.checked })}
        />
        Include completed tasks
      </label>
    </div>
  );
}

function StepAutoPull({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: WizardDraft;
  readonly onChange: (next: WizardDraft) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Auto-pull automatically creates board tickets for matching issues — without any manual
        import step. Leave off to only use the import picker.
      </p>

      <label className="flex items-center gap-3">
        <Switch
          checked={draft.autoPullOn}
          disabled={disabled}
          aria-label="Enable auto-pull"
          onCheckedChange={(checked) =>
            onChange({
              ...draft,
              autoPullOn: checked,
              // When turning off, clear advanced rule so a subsequent re-enable starts fresh.
              advancedRule: checked ? draft.advancedRule : undefined,
            })
          }
        />
        <span className="text-sm font-medium text-foreground">
          {draft.autoPullOn ? "Auto-pull enabled" : "Auto-pull disabled (manual only)"}
        </span>
      </label>

      {draft.autoPullOn ? (
        draft.advancedRule !== undefined ? (
          <div className="rounded-md border border-border/70 bg-muted/10 p-3">
            <p className="text-xs font-semibold text-warning-foreground">Advanced rule</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This source uses a custom jsonLogic rule that the structured editor cannot represent.
              The rule will be preserved as-is. Turn auto-pull off and back on to replace it with
              the structured editor.
            </p>
            <pre className="mt-2 overflow-auto rounded bg-muted/40 p-2 text-[11px] text-foreground">
              {JSON.stringify(draft.advancedRule, null, 2)}
            </pre>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">
              Filter criteria{" "}
              <span className="font-normal text-muted-foreground">
                (leave empty to auto-pull all issues)
              </span>
            </p>
            <AutoPullCriteriaEditor
              value={draft.autoPullCriteria ?? {}}
              disabled={disabled}
              onChange={(next) => onChange({ ...draft, autoPullCriteria: next })}
            />
          </div>
        )
      ) : null}
    </div>
  );
}

function StepLanes({
  draft,
  lanes,
  onChange,
  disabled,
}: {
  readonly draft: WizardDraft;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly onChange: (next: WizardDraft) => void;
  readonly disabled: boolean;
}) {
  // A closed issue routes to a terminal lane (board lint requires closedLane to
  // be terminal), so only terminal lanes are valid choices here.
  const terminalLanes = lanes.filter((lane) => lane.terminal === true);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose where new tickets land and where closed issues route.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Destination lane</span>
          <select
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={draft.destinationLane}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, destinationLane: e.currentTarget.value })}
          >
            {lanes.map((lane) => (
              <option key={String(lane.key)} value={String(lane.key)}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-foreground">Closed lane</span>
          <select
            className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={draft.closedLane}
            disabled={disabled || terminalLanes.length === 0}
            onChange={(e) => onChange({ ...draft, closedLane: e.currentTarget.value })}
          >
            {terminalLanes.map((lane) => (
              <option key={String(lane.key)} value={String(lane.key)}>
                {lane.name}
              </option>
            ))}
          </select>
          {terminalLanes.length === 0 ? (
            <span className="text-xs text-destructive-foreground">
              Add a terminal lane to route closed issues.
            </span>
          ) : null}
        </label>
      </div>
      {draft.syncIntervalSec !== undefined ? (
        <p className="text-xs text-muted-foreground">
          Sync interval: {draft.syncIntervalSec}s (preserved from existing configuration).
        </p>
      ) : null}
    </div>
  );
}

// ─── SourceWizard ───────────────────────────────────────────────────────────────

/**
 * Callback type for creating a new work-source connection INLINE from the wizard.
 * Intentionally only "github" | "asana": the inline form collects just
 * displayName + token, while Jira additionally requires a base URL (+ email for
 * Cloud), so Jira connections are created in Settings and merely selected here.
 */
export type SourceWizardCreateConnection = (input: {
  provider: "github" | "asana";
  displayName: string;
  token: string;
}) => Promise<WorkSourceConnectionView>;

export interface SourceWizardProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: "create" | "edit";
  readonly initial?: WorkflowSourceConfig;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly listWorkSourceConnections: (
    input: Record<string, never>,
  ) => Promise<ReadonlyArray<WorkSourceConnectionView>>;
  readonly createWorkSourceConnection: SourceWizardCreateConnection | undefined;
  readonly onSave: (source: WorkflowSourceConfig) => void;
  /** When true, all step controls are rendered in read-only / disabled state. */
  readonly disabled?: boolean;
}

export function SourceWizard({
  open,
  onOpenChange,
  mode,
  initial,
  lanes,
  listWorkSourceConnections,
  createWorkSourceConnection,
  onSave,
  disabled = false,
}: SourceWizardProps) {
  // Draft — re-initialized each time the dialog opens.
  const [draft, setDraft] = useState<WizardDraft>(() =>
    initial ? initDraftFromSource(initial, String(lanes[0]?.key ?? "")) : newDraft(lanes),
  );
  const [currentStep, setCurrentStep] = useState<WizardStep>(STEPS[0]!);
  const [connections, setConnections] = useState<ReadonlyArray<WorkSourceConnectionView> | null>(
    null,
  );
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  // Re-initialize draft and load connections whenever the dialog transitions to open.
  // Using an effect (rather than handleOpenChange's open branch) ensures this runs
  // for both user-triggered opens (trigger button) and programmatic opens where the
  // parent sets open=true directly — a controlled Dialog does NOT fire onOpenChange
  // in the latter case.
  useEffect(() => {
    if (!open) return;
    setDraft(initial ? initDraftFromSource(initial, String(lanes[0]?.key ?? "")) : newDraft(lanes));
    setCurrentStep(STEPS[0]!);
    setConnectionsLoading(true);
    setConnectionsError(null);
    setConnections(null);
    let active = true;
    void listWorkSourceConnections({})
      .then((result) => {
        if (active) {
          setConnections(result);
          setConnectionsLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnectionsError(
            error instanceof Error ? error.message : "Failed to load connections.",
          );
          setConnectionsLoading(false);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Relay close events (escape / backdrop) to the parent; open events are handled
  // by the useEffect above so we only forward close here.
  const handleOpenChange = (next: boolean) => {
    if (!next) onOpenChange(false);
  };

  const stepIndex = STEPS.indexOf(currentStep);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  const currentError = stepValidationError(draft, currentStep);

  const handleNext = () => {
    if (currentError) return;
    if (!isLast) {
      setCurrentStep(STEPS[stepIndex + 1]!);
    }
  };

  const handleBack = () => {
    if (!isFirst) {
      setCurrentStep(STEPS[stepIndex - 1]!);
    }
  };

  const handleSave = () => {
    // Validate all steps before saving.
    for (const step of STEPS) {
      const err = stepValidationError(draft, step);
      if (err) return;
    }
    const source = buildSourceFromDraft(draft);
    onSave(source);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add work source" : "Edit work source"}</DialogTitle>
          {/* Step indicator */}
          <nav aria-label="Wizard steps" className="flex items-center gap-1 text-xs">
            {STEPS.map((step, i) => (
              <span
                key={step}
                className={[
                  "flex items-center gap-1",
                  i < stepIndex
                    ? "text-muted-foreground"
                    : i === stepIndex
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground/50",
                ].join(" ")}
              >
                {i > 0 ? <span className="text-muted-foreground/40">›</span> : null}
                {stepLabel(step)}
              </span>
            ))}
          </nav>
        </DialogHeader>

        <DialogPanel className="min-h-[16rem] space-y-2">
          {currentStep === "provider" && (
            <StepProvider draft={draft} onChange={setDraft} disabled={disabled} />
          )}
          {currentStep === "connection" && (
            <StepConnection
              draft={draft}
              connections={connections ?? []}
              connectionsLoading={connectionsLoading}
              connectionsError={connectionsError}
              createWorkSourceConnection={createWorkSourceConnection}
              onChange={setDraft}
              disabled={disabled}
            />
          )}
          {currentStep === "scope" && (
            <StepScope draft={draft} onChange={setDraft} disabled={disabled} />
          )}
          {currentStep === "autoPull" && (
            <StepAutoPull draft={draft} onChange={setDraft} disabled={disabled} />
          )}
          {currentStep === "lanes" && (
            <StepLanes draft={draft} lanes={lanes} onChange={setDraft} disabled={disabled} />
          )}
          {currentError ? <p className="text-[11px] text-destructive">{currentError}</p> : null}
        </DialogPanel>

        <DialogFooter variant="bare">
          <Button
            variant="outline"
            size="sm"
            onClick={isFirst ? () => onOpenChange(false) : handleBack}
          >
            {isFirst ? "Cancel" : "Back"}
          </Button>
          {isLast ? (
            <Button size="sm" disabled={currentError !== null} onClick={handleSave}>
              {mode === "create" ? "Add source" : "Save source"}
            </Button>
          ) : (
            <Button size="sm" disabled={currentError !== null} onClick={handleNext}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
