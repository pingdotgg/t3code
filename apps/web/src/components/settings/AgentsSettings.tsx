import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  FileCode2Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentCatalogDiagnostic,
  AgentProfileSummary,
  EnvironmentId,
} from "@t3tools/contracts";

import { useActiveEnvironmentId, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentEnvironment } from "../../state/agents";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildAgentProfileDocument,
  draftFromProfile,
  agentSettingsContextKey,
  resolveProfileBaselineForSave,
  sortAgentProfiles,
  type AgentProfileDraft,
} from "./AgentsSettings.logic";
import { RulesSettingsPanel } from "./RulesSettings";

const selectClass =
  "h-8 min-w-40 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";
const compactInputClass = "w-full sm:w-64";
const nowKey = (profile: AgentProfileSummary) => `${profile.scope}:${profile.id}`;
const diagnosticLabel = (diagnostic: AgentCatalogDiagnostic): string =>
  `${diagnostic.scope} ${diagnostic.kind}${diagnostic.id ? ` '${diagnostic.id}'` : ""}: ${diagnostic.message}`;

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The profile request failed.";
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {help ? (
        <span className="block text-[11px] leading-4 text-muted-foreground/75">{help}</span>
      ) : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  help?: string;
}) {
  return (
    <Field label={label} help={help}>
      <select
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, optionLabel]) => (
          <option key={option} value={option}>
            {optionLabel}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SummaryRow({
  profile,
  selected,
  onSelect,
}: {
  profile: AgentProfileSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${selected ? "bg-accent text-foreground" : "hover:bg-accent/50"}`}
    >
      <BotIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{profile.name}</span>
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            {profile.scope}
          </span>
          {profile.archivedAt ? (
            <span className="shrink-0 rounded border border-warning/40 px-1.5 py-0.5 text-[10px] text-warning">
              archived
            </span>
          ) : null}
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            {profile.chatSelectable ? "chat" : "delegation only"}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {profile.description || profile.id}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

export function AgentsSettingsPanel() {
  const activeEnvironmentId = useActiveEnvironmentId();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const environmentId = activeEnvironmentId ?? environments[0]?.environmentId ?? null;
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const resolvedEnvironmentId = selectedEnvironmentId ?? environmentId;
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === resolvedEnvironmentId),
    [projects, resolvedEnvironmentId],
  );
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const selectedProject = environmentProjects.find(
    (project) => String(project.id) === selectedProjectId,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const [draft, setDraft] = useState<AgentProfileDraft>(() => draftFromProfile());
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settingsContextKey = agentSettingsContextKey({
    environmentId: resolvedEnvironmentId,
    projectId: selectedProject?.id?.toString() ?? null,
    selectionKey: selectedKey,
    generation: contextGeneration,
  });
  const settingsContextKeyRef = useRef(settingsContextKey);
  settingsContextKeyRef.current = settingsContextKey;

  useEffect(() => {
    if (resolvedEnvironmentId !== null && selectedEnvironmentId === null) {
      setSelectedEnvironmentId(resolvedEnvironmentId);
    }
  }, [resolvedEnvironmentId, selectedEnvironmentId]);
  useEffect(() => {
    if (selectedProjectId && !selectedProject) setSelectedProjectId("");
  }, [selectedProject, selectedProjectId]);

  const catalogQuery = useEnvironmentQuery(
    resolvedEnvironmentId === null
      ? null
      : agentEnvironment.catalog({
          environmentId: resolvedEnvironmentId,
          input: {
            includeArchived: true,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
          },
        }),
  );
  const selectedSummary =
    catalogQuery.data?.profiles.find((profile) => nowKey(profile) === selectedKey) ?? null;
  const profileQuery = useEnvironmentQuery(
    resolvedEnvironmentId === null || selectedSummary === null
      ? null
      : agentEnvironment.profile({
          environmentId: resolvedEnvironmentId,
          input: {
            id: selectedSummary.id,
            scope: selectedSummary.scope,
            revision: selectedSummary.revision,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
          },
        }),
  );
  useEffect(() => {
    if (profileQuery.data?.profile && selectedSummary !== null) {
      setDraft(
        draftFromProfile({ profile: profileQuery.data.profile, projectId: selectedProjectId }),
      );
      setIsNew(false);
    }
  }, [profileQuery.data, selectedProjectId, selectedSummary]);

  const saveProfile = useAtomCommand(agentEnvironment.saveProfile, { reportFailure: false });
  const archiveProfile = useAtomCommand(agentEnvironment.archiveProfile, { reportFailure: false });
  const restoreProfile = useAtomCommand(agentEnvironment.restoreProfile, { reportFailure: false });
  const updateDraft = <K extends keyof AgentProfileDraft>(key: K, value: AgentProfileDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError(null);
    setNotice(null);
  };
  const startNew = () => {
    setContextGeneration((generation) => generation + 1);
    setSelectedKey(null);
    setDraft(
      draftFromProfile({
        scope: selectedProject ? "project" : "environment",
        projectId: selectedProjectId,
      }),
    );
    setIsNew(true);
    setError(null);
    setNotice(null);
  };
  const handleSave = async () => {
    if (resolvedEnvironmentId === null) return;
    const saveContextKey = settingsContextKey;
    try {
      if (draft.scope === "project" && selectedProject === undefined) {
        throw new Error("Choose a project before saving a project-scoped profile.");
      }
      const baseline = resolveProfileBaselineForSave(
        isNew,
        selectedSummary,
        profileQuery.data?.profile,
      );
      const document = buildAgentProfileDocument(draft, baseline);
      const result = await saveProfile({
        environmentId: resolvedEnvironmentId,
        input: {
          profile: document,
          ...(baseline === null ? {} : { expectedRevision: baseline.revision }),
          ...(document.scope === "project" && selectedProject
            ? { projectId: selectedProject.id }
            : {}),
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result.cause));
      if (settingsContextKeyRef.current !== saveContextKey) return;
      setNotice("Profile saved.");
      setSelectedKey(nowKey(result.value.profile));
      setIsNew(false);
      catalogQuery.refresh();
      profileQuery.refresh();
    } catch (caught) {
      if (settingsContextKeyRef.current !== saveContextKey) return;
      setError(caught instanceof Error ? caught.message : "The profile could not be saved.");
    }
  };
  const handleArchiveRestore = async () => {
    if (resolvedEnvironmentId === null || selectedSummary === null) return;
    const actionContextKey = settingsContextKey;
    const command = selectedSummary.archivedAt ? restoreProfile : archiveProfile;
    const result = await command({
      environmentId: resolvedEnvironmentId,
      input: {
        id: selectedSummary.id,
        scope: selectedSummary.scope,
        expectedRevision: selectedSummary.revision,
        ...(selectedSummary.scope === "project" && selectedProject
          ? { projectId: selectedProject.id }
          : {}),
      },
    });
    if (result._tag === "Failure") {
      if (settingsContextKeyRef.current !== actionContextKey) return;
      setError(failureMessage(result.cause));
      return;
    }
    if (settingsContextKeyRef.current !== actionContextKey) return;
    setNotice(selectedSummary.archivedAt ? "Profile restored." : "Profile archived.");
    catalogQuery.refresh();
    profileQuery.refresh();
  };

  const sortedProfiles = useMemo(
    () => sortAgentProfiles(catalogQuery.data?.profiles ?? []),
    [catalogQuery.data?.profiles],
  );
  const noEnvironment = resolvedEnvironmentId === null;
  const canEdit = isNew || (selectedSummary !== null && profileQuery.data?.profile !== undefined);

  return (
    <SettingsPageContainer className="max-w-6xl gap-8">
      <SettingsSection
        id="agents"
        title="Agents"
        icon={<BotIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button size="sm" onClick={startNew} disabled={noEnvironment}>
            <PlusIcon /> New profile
          </Button>
        }
      >
        <SettingsRow
          title="Profile context"
          description="Environment profiles are shared by the host. Choose a project to manage project-scoped profiles."
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <select
                className={selectClass}
                aria-label="Agent environment"
                value={resolvedEnvironmentId ?? ""}
                onChange={(event) => {
                  setContextGeneration((generation) => generation + 1);
                  setSelectedEnvironmentId((event.target.value || null) as EnvironmentId | null);
                  setSelectedProjectId("");
                  setSelectedKey(null);
                  setIsNew(false);
                }}
              >
                {environments.length === 0 ? <option value="">No environments</option> : null}
                {environments.map((environment) => (
                  <option key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                aria-label="Agent project"
                value={selectedProjectId}
                onChange={(event) => {
                  setContextGeneration((generation) => generation + 1);
                  setSelectedProjectId(event.target.value);
                  setSelectedKey(null);
                  setIsNew(false);
                }}
              >
                <option value="">Environment profiles</option>
                {environmentProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </div>
          }
        />
        {(catalogQuery.data?.diagnostics.length ?? 0) > 0 ? (
          <div
            className="mx-3 space-y-1 rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning sm:mx-4"
            role="alert"
          >
            <p className="font-medium">Some Agent files could not be loaded.</p>
            {catalogQuery.data?.diagnostics.slice(0, 3).map((diagnostic, index) => (
              <p key={`${diagnostic.code}:${diagnostic.sourcePath ?? diagnostic.id ?? index}`}>
                {diagnosticLabel(diagnostic)}
              </p>
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 px-3 sm:px-4 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.6fr)]">
          <div
            className="rounded-xl border border-border/70 bg-muted/15 p-2"
            aria-label="Agent profiles"
          >
            {catalogQuery.isPending && catalogQuery.data === null ? (
              <div
                className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner className="size-4" /> Loading profiles…
              </div>
            ) : catalogQuery.error ? (
              <div className="space-y-3 px-3 py-8 text-sm text-destructive" role="alert">
                <p>{catalogQuery.error}</p>
                <Button size="xs" variant="outline" onClick={catalogQuery.refresh}>
                  Retry
                </Button>
              </div>
            ) : noEnvironment ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                Connect an environment to manage agent profiles.
              </div>
            ) : sortedProfiles.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                No profiles in this context. Create one to define reusable agent instructions.
              </div>
            ) : (
              <div className="space-y-0.5">
                {sortedProfiles.map((profile) => (
                  <SummaryRow
                    key={nowKey(profile)}
                    profile={profile}
                    selected={nowKey(profile) === selectedKey}
                    onSelect={() => {
                      setContextGeneration((generation) => generation + 1);
                      setSelectedKey(nowKey(profile));
                      setIsNew(false);
                      setError(null);
                      setNotice(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-xl border border-border/70 p-3 sm:p-4">
            {isNew || selectedSummary ? (
              <ProfileEditor
                draft={draft}
                isNew={isNew}
                selectedSummary={selectedSummary}
                canEdit={canEdit}
                error={error ?? profileQuery.error}
                notice={notice}
                isLoading={profileQuery.isPending}
                onChange={updateDraft}
                onSave={() => void handleSave()}
                onArchiveRestore={() => void handleArchiveRestore()}
              />
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <FileCode2Icon className="size-6 text-muted-foreground/60" />
                <p>Select a profile to edit its policy.</p>
                <p className="text-xs">Archived profiles stay available here for restore.</p>
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
      <RulesSettingsPanel />
    </SettingsPageContainer>
  );
}

export function ProfileEditor({
  draft,
  isNew,
  selectedSummary,
  canEdit,
  error,
  notice,
  isLoading,
  onChange,
  onSave,
  onArchiveRestore,
}: {
  draft: AgentProfileDraft;
  isNew: boolean;
  selectedSummary: AgentProfileSummary | null;
  canEdit: boolean;
  error: string | null;
  notice: string | null;
  isLoading: boolean;
  onChange: <K extends keyof AgentProfileDraft>(key: K, value: AgentProfileDraft[K]) => void;
  onSave: () => void;
  onArchiveRestore: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {isNew ? "New agent profile" : draft.name || "Agent profile"}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {isNew
              ? "Create a durable, provider-neutral policy."
              : `Revision ${selectedSummary?.revision.slice(0, 8) ?? "—"}…`}
          </p>
        </div>
        <div className="flex gap-2">
          {selectedSummary ? (
            <Button size="xs" variant="outline" onClick={onArchiveRestore} disabled={isLoading}>
              {selectedSummary.archivedAt ? <RotateCcwIcon /> : <ArchiveIcon />}
              {selectedSummary.archivedAt ? "Restore" : "Archive"}
            </Button>
          ) : null}
          <Button size="xs" onClick={onSave} disabled={!canEdit || isLoading}>
            {isLoading ? <Spinner /> : <SaveIcon />}
            Save
          </Button>
        </div>
      </div>
      {error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/8 px-3 py-2 text-xs text-success"
          role="status"
        >
          <CheckIcon className="size-3.5" />
          {notice}
        </div>
      ) : null}
      {isLoading ? (
        <div className="text-xs text-muted-foreground" role="status">
          Loading profile details…
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Profile id" help="Stable slug used by rules and delegation.">
          <Input
            nativeInput
            className={compactInputClass}
            value={draft.id}
            onChange={(event) => onChange("id", event.target.value)}
            disabled={!isNew}
            aria-label="Profile id"
          />
        </Field>
        <Field label="Name">
          <Input
            nativeInput
            className={compactInputClass}
            value={draft.name}
            onChange={(event) => onChange("name", event.target.value)}
            aria-label="Profile name"
          />
        </Field>
        <Field label="Scope">
          <select
            className={selectClass}
            value={draft.scope}
            disabled={!isNew}
            onChange={(event) =>
              onChange("scope", event.target.value as AgentProfileDraft["scope"])
            }
            aria-label="Profile scope"
          >
            <option value="environment">Environment</option>
            <option value="project">Project</option>
          </select>
        </Field>
        <Field label="Description">
          <Input
            nativeInput
            className={compactInputClass}
            value={draft.description}
            onChange={(event) => onChange("description", event.target.value)}
            aria-label="Profile description"
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Show in chat Agent picker</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Turn this off for specialist profiles that should only be started by orchestration.
          </p>
        </div>
        <Switch
          checked={draft.chatSelectable}
          onCheckedChange={(checked) => onChange("chatSelectable", Boolean(checked))}
          aria-label="Show in chat Agent picker"
        />
      </div>
      <Field label="Instructions" help="Included in every turn resolved through this profile.">
        <Textarea
          value={draft.instructions}
          onChange={(event) => onChange("instructions", event.target.value)}
          aria-label="Profile instructions"
          className="min-h-32"
        />
      </Field>

      <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
        <SelectField
          label="Instruction priority"
          value={draft.instructionPriority}
          onChange={(value) =>
            onChange("instructionPriority", value as AgentProfileDraft["instructionPriority"])
          }
          options={[
            ["prompt", "Prompt"],
            ["system-required", "System required"],
          ]}
        />
        <SelectField
          label="Runtime mode"
          value={draft.runtimeMode}
          onChange={(value) => onChange("runtimeMode", value as AgentProfileDraft["runtimeMode"])}
          options={[
            ["full-access", "Full access"],
            ["auto", "Auto"],
            ["auto-accept-edits", "Auto-accept edits"],
            ["approval-required", "Approval required"],
          ]}
        />
        <SelectField
          label="Interaction mode"
          value={draft.interactionMode}
          onChange={(value) =>
            onChange("interactionMode", value as AgentProfileDraft["interactionMode"])
          }
          options={[
            ["default", "Default"],
            ["plan", "Plan"],
          ]}
        />
        <SelectField
          label="Workspace mode"
          value={draft.workspaceMode}
          onChange={(value) =>
            onChange("workspaceMode", value as AgentProfileDraft["workspaceMode"])
          }
          options={[
            ["shared", "Shared workspace"],
            ["isolated-worktree", "Isolated worktree"],
          ]}
        />
        <SelectField
          label="Workspace access"
          value={draft.workspaceAccess}
          onChange={(value) =>
            onChange("workspaceAccess", value as AgentProfileDraft["workspaceAccess"])
          }
          options={[
            ["workspace-write", "Workspace write"],
            ["read-only", "Read only"],
            ["full-access", "Full access"],
          ]}
        />
        <Field label="Shared write concurrency">
          <Input
            nativeInput
            type="number"
            min="1"
            max="8"
            className={compactInputClass}
            value={draft.sharedWriteConcurrency}
            onChange={(event) => onChange("sharedWriteConcurrency", event.target.value)}
            aria-label="Shared write concurrency"
          />
        </Field>
      </div>

      <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
        <SelectField
          label="Tool requirement"
          value={draft.toolRequirement}
          onChange={(value) =>
            onChange("toolRequirement", value as AgentProfileDraft["toolRequirement"])
          }
          options={[
            ["none", "None"],
            ["sandbox", "Sandbox"],
            ["exact", "Exact"],
          ]}
        />
        <Field label="T3 MCP capabilities" help="Comma-separated capability slugs.">
          <Input
            nativeInput
            className={compactInputClass}
            value={draft.t3McpCapabilities}
            onChange={(event) => onChange("t3McpCapabilities", event.target.value)}
            aria-label="T3 MCP capabilities"
          />
        </Field>
        <SelectField
          label="Tools policy"
          value={draft.toolsPolicy}
          onChange={(value) => onChange("toolsPolicy", value as AgentProfileDraft["toolsPolicy"])}
          options={[
            ["inherit", "Inherit"],
            ["allowlist", "Allowlist"],
          ]}
        />
        <Field label="Allowed tools" help="Comma-separated tool slugs.">
          <Input
            nativeInput
            className={compactInputClass}
            value={draft.allowedTools}
            onChange={(event) => onChange("allowedTools", event.target.value)}
            aria-label="Allowed tools"
          />
        </Field>
        <SelectField
          label="Delegation policy"
          value={draft.delegationPolicy}
          onChange={(value) =>
            onChange("delegationPolicy", value as AgentProfileDraft["delegationPolicy"])
          }
          options={[
            ["disabled", "Disabled"],
            ["allowlist", "Allowlist"],
          ]}
        />
      </div>

      <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
        <Field
          label="Default model selection"
          help={'Optional JSON object, for example {"instanceId":"codex","model":"gpt-5"}.'}
        >
          <Textarea
            value={draft.defaultModelSelection}
            onChange={(event) => onChange("defaultModelSelection", event.target.value)}
            aria-label="Default model selection"
            className="min-h-24 font-mono text-xs"
          />
        </Field>
        <Field label="Delegated profiles" help="JSON array of profile locators with id and scope.">
          <Textarea
            value={draft.delegatedProfiles}
            onChange={(event) => onChange("delegatedProfiles", event.target.value)}
            aria-label="Delegated profiles"
            className="min-h-24 font-mono text-xs"
          />
        </Field>
      </div>
      <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Maximum runs">
          <Input
            nativeInput
            type="number"
            min="1"
            max="32"
            value={draft.maxRuns}
            onChange={(event) => onChange("maxRuns", event.target.value)}
            aria-label="Maximum runs"
          />
        </Field>
        <Field label="Maximum concurrency">
          <Input
            nativeInput
            type="number"
            min="1"
            max="8"
            value={draft.maxConcurrency}
            onChange={(event) => onChange("maxConcurrency", event.target.value)}
            aria-label="Maximum concurrency"
          />
        </Field>
        <Field label="Maximum delegation depth">
          <Input
            nativeInput
            type="number"
            min="0"
            max="4"
            value={draft.maxDepth}
            onChange={(event) => onChange("maxDepth", event.target.value)}
            aria-label="Maximum delegation depth"
          />
        </Field>
        <Field label="Wall time (minutes)">
          <Input
            nativeInput
            type="number"
            min="1"
            max="120"
            value={draft.maxWallTimeMinutes}
            onChange={(event) => onChange("maxWallTimeMinutes", event.target.value)}
            aria-label="Maximum wall time minutes"
          />
        </Field>
        <Field label="Total tokens (optional)">
          <Input
            nativeInput
            type="number"
            min="1"
            value={draft.maxTotalTokens}
            onChange={(event) => onChange("maxTotalTokens", event.target.value)}
            aria-label="Maximum total tokens"
          />
        </Field>
        <Field label="Estimated cost (optional)">
          <Input
            nativeInput
            type="number"
            min="0"
            step="0.01"
            value={draft.maxEstimatedCostUsd}
            onChange={(event) => onChange("maxEstimatedCostUsd", event.target.value)}
            aria-label="Maximum estimated cost"
          />
        </Field>
      </div>
      <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
        <Field label="Hooks" help="JSON array of context or shell hooks.">
          <Textarea
            value={draft.hooks}
            onChange={(event) => onChange("hooks", event.target.value)}
            aria-label="Profile hooks"
            className="min-h-32 font-mono text-xs"
          />
        </Field>
        <Field label="Rules" help="JSON array of rule references with id and path.">
          <Textarea
            value={draft.rules}
            onChange={(event) => onChange("rules", event.target.value)}
            aria-label="Profile rules"
            className="min-h-32 font-mono text-xs"
          />
        </Field>
      </div>
    </div>
  );
}
