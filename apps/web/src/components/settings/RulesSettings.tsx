import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  FileCode2Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentProfileId,
  type AgentCatalogDiagnostic,
  type AgentRuleSummary,
  type EnvironmentId,
} from "@t3tools/contracts";

import { useActiveEnvironmentId, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentEnvironment } from "../../state/agents";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { agentSettingsContextKey } from "./AgentsSettings.logic";
import {
  buildAgentRuleDocument,
  draftFromRule,
  resolveRuleBaselineForSave,
  sortAgentRules,
  type AgentRuleDraft,
} from "./RulesSettings.logic";

const selectClass =
  "h-8 min-w-40 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";
const keyOf = (rule: AgentRuleSummary) => `${rule.scope}:${rule.id}`;
const diagnosticLabel = (diagnostic: AgentCatalogDiagnostic): string =>
  `${diagnostic.scope} ${diagnostic.kind}${diagnostic.id ? ` '${diagnostic.id}'` : ""}: ${diagnostic.message}`;
const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The rule request failed.";
};

export function RulesSettingsPanel() {
  const activeEnvironmentId = useActiveEnvironmentId();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const fallbackEnvironmentId = activeEnvironmentId ?? environments[0]?.environmentId ?? null;
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const resolvedEnvironmentId = environmentId ?? fallbackEnvironmentId;
  const [projectId, setProjectId] = useState("");
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === resolvedEnvironmentId),
    [projects, resolvedEnvironmentId],
  );
  const project = environmentProjects.find((item) => String(item.id) === projectId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const [draft, setDraft] = useState<AgentRuleDraft>(() => draftFromRule());
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const mutationInFlight = useRef(false);
  const settingsContextKey = agentSettingsContextKey({
    environmentId: resolvedEnvironmentId,
    projectId: project?.id?.toString() ?? null,
    selectionKey: selectedKey,
    generation: contextGeneration,
  });
  const settingsContextKeyRef = useRef(settingsContextKey);
  settingsContextKeyRef.current = settingsContextKey;
  useEffect(() => {
    if (resolvedEnvironmentId && environmentId === null) setEnvironmentId(resolvedEnvironmentId);
  }, [environmentId, resolvedEnvironmentId]);
  useEffect(() => {
    if (projectId && !project) setProjectId("");
  }, [project, projectId]);
  const catalog = useEnvironmentQuery(
    resolvedEnvironmentId === null
      ? null
      : agentEnvironment.catalog({
          environmentId: resolvedEnvironmentId,
          input: { includeArchived: true, ...(project ? { projectId: project.id } : {}) },
        }),
  );
  const selectedSummary = catalog.data?.rules.find((rule) => keyOf(rule) === selectedKey) ?? null;
  const ruleQuery = useEnvironmentQuery(
    resolvedEnvironmentId === null || selectedSummary === null
      ? null
      : agentEnvironment.rule({
          environmentId: resolvedEnvironmentId,
          input: {
            id: AgentProfileId.make(selectedSummary.id),
            scope: selectedSummary.scope,
            revision: selectedSummary.revision,
            ...(project ? { projectId: project.id } : {}),
          },
        }),
  );
  useEffect(() => {
    if (ruleQuery.data?.rule && selectedSummary) {
      setDraft(draftFromRule(ruleQuery.data.rule));
      setIsNew(false);
    }
  }, [ruleQuery.data, selectedSummary]);
  const saveRule = useAtomCommand(agentEnvironment.saveRule, { reportFailure: false });
  const archiveRule = useAtomCommand(agentEnvironment.archiveRule, { reportFailure: false });
  const restoreRule = useAtomCommand(agentEnvironment.restoreRule, { reportFailure: false });
  const update = <K extends keyof AgentRuleDraft>(key: K, value: AgentRuleDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError(null);
    setNotice(null);
  };
  const startNew = () => {
    setContextGeneration((generation) => generation + 1);
    setSelectedKey(null);
    setDraft(draftFromRule(null, project ? "project" : "environment"));
    setIsNew(true);
    setError(null);
    setNotice(null);
  };
  const save = async () => {
    if (!resolvedEnvironmentId || mutationInFlight.current) return;
    const saveContextKey = settingsContextKey;
    mutationInFlight.current = true;
    setIsMutating(true);
    try {
      if (draft.scope === "project" && !project)
        throw new Error("Choose a project before saving a project-scoped rule.");
      const baseline = resolveRuleBaselineForSave(isNew, selectedSummary, ruleQuery.data?.rule);
      const rule = buildAgentRuleDocument(draft, baseline);
      const result = await saveRule({
        environmentId: resolvedEnvironmentId,
        input: {
          rule,
          ...(baseline === null ? {} : { expectedRevision: baseline.revision }),
          ...(rule.scope === "project" && project ? { projectId: project.id } : {}),
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result.cause));
      if (settingsContextKeyRef.current !== saveContextKey) return;
      setDraft(draftFromRule(result.value.rule));
      setSelectedKey(keyOf(result.value.rule));
      setIsNew(false);
      setNotice("Rule saved.");
      await catalog.refresh();
    } catch (cause) {
      if (settingsContextKeyRef.current !== saveContextKey) return;
      setError(
        cause instanceof Error ? cause.message : failureMessage(cause as Cause.Cause<unknown>),
      );
    } finally {
      mutationInFlight.current = false;
      setIsMutating(false);
    }
  };
  const archiveRestore = async () => {
    if (!resolvedEnvironmentId || !selectedSummary || mutationInFlight.current) return;
    const actionContextKey = settingsContextKey;
    mutationInFlight.current = true;
    setIsMutating(true);
    try {
      const command = selectedSummary.archivedAt ? restoreRule : archiveRule;
      const result = await command({
        environmentId: resolvedEnvironmentId,
        input: {
          id: AgentProfileId.make(selectedSummary.id),
          scope: selectedSummary.scope,
          expectedRevision: selectedSummary.revision,
          ...(selectedSummary.scope === "project" && project ? { projectId: project.id } : {}),
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result.cause));
      if (settingsContextKeyRef.current !== actionContextKey) return;
      setDraft(draftFromRule(result.value.rule));
      setSelectedKey(keyOf(result.value.rule));
      setNotice(
        result.value.rule.archivedAt ? "Rule archived. It can be restored here." : "Rule restored.",
      );
      await catalog.refresh();
    } catch (cause) {
      if (settingsContextKeyRef.current !== actionContextKey) return;
      setError(cause instanceof Error ? cause.message : "The rule request failed.");
    } finally {
      mutationInFlight.current = false;
      setIsMutating(false);
    }
  };
  const rules = sortAgentRules(catalog.data?.rules ?? []);
  const disabled =
    resolvedEnvironmentId === null ||
    (!isNew && selectedSummary?.archivedAt !== null && selectedSummary?.archivedAt !== undefined);
  return (
    <SettingsSection
      title="Rules"
      icon={<FileCode2Icon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button size="sm" onClick={startNew} disabled={resolvedEnvironmentId === null}>
          <PlusIcon /> New rule
        </Button>
      }
    >
      <SettingsRow
        title="Rule context"
        description="Rules add file-aware instructions to matching work. Project rules are checked in with the repository."
        control={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <select
              className={selectClass}
              aria-label="Rule environment"
              value={resolvedEnvironmentId ?? ""}
              onChange={(event) => {
                setContextGeneration((generation) => generation + 1);
                setEnvironmentId((event.target.value || null) as EnvironmentId | null);
                setProjectId("");
                setSelectedKey(null);
                setIsNew(false);
              }}
            >
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              aria-label="Rule project"
              value={projectId}
              onChange={(event) => {
                setContextGeneration((generation) => generation + 1);
                setProjectId(event.target.value);
                setSelectedKey(null);
                setIsNew(false);
              }}
            >
              <option value="">Environment rules</option>
              {environmentProjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>
        }
      />
      {(catalog.data?.diagnostics.length ?? 0) > 0 ? (
        <div
          className="mx-3 space-y-1 rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning sm:mx-4"
          role="alert"
        >
          <p className="font-medium">Some rule files could not be loaded.</p>
          {catalog.data?.diagnostics.slice(0, 3).map((diagnostic, index) => (
            <p key={`${diagnostic.code}:${diagnostic.sourcePath ?? diagnostic.id ?? index}`}>
              {diagnosticLabel(diagnostic)}
            </p>
          ))}
        </div>
      ) : null}
      <div className="grid gap-3 px-3 sm:px-4 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.6fr)]">
        <div
          className="rounded-xl border border-border/70 bg-muted/15 p-2"
          aria-label="Agent rules"
        >
          {catalog.isPending && !catalog.data ? (
            <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading rules…
            </div>
          ) : catalog.error ? (
            <div className="px-3 py-8 text-sm text-destructive">{catalog.error}</div>
          ) : rules.length === 0 ? (
            <div className="px-3 py-8 text-sm text-muted-foreground">
              No rules in this context. Create one for file-aware guidance.
            </div>
          ) : (
            <div className="space-y-0.5">
              {rules.map((rule) => (
                <button
                  key={keyOf(rule)}
                  type="button"
                  onClick={() => {
                    setContextGeneration((generation) => generation + 1);
                    setSelectedKey(keyOf(rule));
                    setIsNew(false);
                    setError(null);
                    setNotice(null);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${selectedKey === keyOf(rule) ? "bg-accent" : "hover:bg-accent/50"}`}
                >
                  <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex gap-2 text-sm font-medium">
                      <span className="truncate">{rule.name}</span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase text-muted-foreground">
                        {rule.scope}
                      </span>
                      {rule.archivedAt ? (
                        <span className="text-[10px] text-warning">archived</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {rule.description || rule.globs.join(", ") || rule.id}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 text-muted-foreground/60" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0 rounded-xl border border-border/70 p-3 sm:p-4">
          {isNew || selectedSummary ? (
            <RuleEditor
              draft={draft}
              isNew={isNew}
              archived={
                selectedSummary?.archivedAt !== null && selectedSummary?.archivedAt !== undefined
              }
              isLoading={ruleQuery.isPending}
              error={error ?? ruleQuery.error}
              notice={notice}
              disabled={disabled}
              isMutating={isMutating}
              onChange={update}
              onSave={() => void save()}
              onArchiveRestore={() => void archiveRestore()}
            />
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <FileCode2Icon className="size-6 text-muted-foreground/60" />
              <p>Select a rule to edit its matching instructions.</p>
              <p className="text-xs">Archived rules remain available for restore.</p>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

export function RuleEditor({
  draft,
  isNew,
  archived,
  isLoading,
  error,
  notice,
  disabled,
  isMutating,
  onChange,
  onSave,
  onArchiveRestore,
}: {
  draft: AgentRuleDraft;
  isNew: boolean;
  archived: boolean;
  isLoading: boolean;
  error: string | null;
  notice: string | null;
  disabled: boolean;
  isMutating: boolean;
  onChange: <K extends keyof AgentRuleDraft>(key: K, value: AgentRuleDraft[K]) => void;
  onSave: () => void;
  onArchiveRestore: () => void;
}) {
  const editorDisabled = disabled || isLoading || isMutating;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{isNew ? "New rule" : draft.name || "Rule"}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Rules are injected only when their file conditions match.
          </p>
        </div>
        <div className="flex gap-2">
          {!isNew ? (
            <Button
              size="xs"
              variant="outline"
              onClick={onArchiveRestore}
              disabled={isLoading || isMutating}
            >
              {archived ? <RotateCcwIcon /> : <ArchiveIcon />}
              {archived ? "Restore" : "Archive"}
            </Button>
          ) : null}
          <Button size="xs" onClick={onSave} disabled={editorDisabled}>
            {isLoading || isMutating ? <Spinner /> : <SaveIcon />} Save
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
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium">Rule id</span>
          <Input
            nativeInput
            value={draft.id}
            disabled={!isNew || editorDisabled}
            onChange={(event) => onChange("id", event.target.value)}
            aria-label="Rule id"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium">Name</span>
          <Input
            nativeInput
            value={draft.name}
            disabled={editorDisabled}
            onChange={(event) => onChange("name", event.target.value)}
            aria-label="Rule name"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium">Scope</span>
          <select
            className={selectClass}
            value={draft.scope}
            disabled={!isNew || editorDisabled}
            onChange={(event) => onChange("scope", event.target.value as AgentRuleDraft["scope"])}
            aria-label="Rule scope"
          >
            <option value="environment">Environment</option>
            <option value="project">Project</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium">Priority</span>
          <Input
            nativeInput
            type="number"
            min="-100"
            max="100"
            value={draft.priority}
            disabled={editorDisabled}
            onChange={(event) => onChange("priority", event.target.value)}
            aria-label="Rule priority"
          />
        </label>
        <label className="space-y-1.5 sm:col-span-2">
          <span className="text-xs font-medium">Description</span>
          <Input
            nativeInput
            value={draft.description}
            disabled={editorDisabled}
            onChange={(event) => onChange("description", event.target.value)}
            aria-label="Rule description"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.alwaysApply}
          disabled={editorDisabled}
          onChange={(event) => onChange("alwaysApply", event.target.checked)}
          aria-label="Always apply rule"
        />{" "}
        Always apply
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium">File globs</span>
        <Textarea
          value={draft.globs}
          disabled={editorDisabled}
          onChange={(event) => onChange("globs", event.target.value)}
          aria-label="Rule file globs"
          placeholder={"src/**/*.ts\n**/*.test.ts"}
        />
        <span className="block text-[11px] text-muted-foreground/75">
          One workspace-relative glob per line. Comma-separated input is also supported when it is
          outside brace alternation. Leave empty only for an always-applied rule.
        </span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium">Profiles</span>
        <Textarea
          value={draft.profiles}
          disabled={editorDisabled}
          onChange={(event) => onChange("profiles", event.target.value)}
          aria-label="Rule profiles"
          className="min-h-24 font-mono text-xs"
        />
        <span className="block text-[11px] text-muted-foreground/75">
          Optional JSON array of profile locators. Empty applies to every profile.
        </span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium">Instructions</span>
        <Textarea
          value={draft.body}
          disabled={editorDisabled}
          onChange={(event) => onChange("body", event.target.value)}
          aria-label="Rule instructions"
          className="min-h-40"
        />
      </label>
    </div>
  );
}
