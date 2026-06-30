import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  decodeAutoPullRule,
  effectiveAutoPullRule,
  summarizeAutoPull,
  type WorkSourceConnectionView,
  type WorkflowSourceConfig,
} from "@t3tools/contracts/workSource";
import type { WorkflowDefinitionEncoded, WorkflowLintError } from "@t3tools/contracts";

import { decodeSelectorDraft } from "./selectorDraft";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { lintErrorKey } from "~/workflow/editorModel";
import type { WorkflowEditorMutation, WorkflowLaneEncoded } from "./WorkflowEditor";
import { SourceWizard, type SourceWizardCreateConnection } from "./SourceWizard";

// ─── types ───────────────────────────────────────────────────────────────────

type SourceEncoded = NonNullable<WorkflowDefinitionEncoded["sources"]>[number];

// ─── component ───────────────────────────────────────────────────────────────

export interface SourcesSectionProps {
  readonly definition: WorkflowDefinitionEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
  readonly listWorkSourceConnections: (
    input: Record<string, never>,
  ) => Promise<ReadonlyArray<WorkSourceConnectionView>>;
  /**
   * When provided, the SourceWizard includes an inline connection-creation
   * sub-form so the user can create a new connection without leaving the editor.
   * When omitted the wizard still opens but only allows selecting an existing
   * connection.
   */
  readonly createWorkSourceConnection?: SourceWizardCreateConnection | undefined;
  /**
   * Increment this value to programmatically open the wizard in create mode
   * (e.g. from the toolbar Sources button when the board has no sources).
   * The effect fires whenever the value changes from 0 to a non-zero value.
   */
  readonly triggerCreate?: number | undefined;
}

export function SourcesSection({
  definition,
  lanes,
  lintErrors,
  disabled = false,
  onMutate,
  listWorkSourceConnections,
  createWorkSourceConnection,
  triggerCreate,
}: SourcesSectionProps) {
  const [connections, setConnections] = useState<ReadonlyArray<WorkSourceConnectionView> | null>(
    null,
  );
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardInitial, setWizardInitial] = useState<WorkflowSourceConfig | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setConnections(null);
    setConnectionsError(null);
    listWorkSourceConnections({})
      .then((result) => {
        if (active) setConnections(result);
      })
      .catch((error: unknown) => {
        if (active)
          setConnectionsError(
            error instanceof Error ? error.message : "Failed to load connections.",
          );
      });
    return () => {
      active = false;
    };
  }, [listWorkSourceConnections]);

  // Open the create wizard when the toolbar Sources button fires triggerCreate.
  useEffect(() => {
    if (triggerCreate) {
      setWizardInitial(undefined);
      setWizardOpen(true);
    }
  }, [triggerCreate]);

  const sources = definition.sources ?? [];

  // Lint errors that mention a source (no laneKey, no stepKey)
  const sourceLintErrors = lintErrors.filter(
    (e) => e.laneKey === undefined && e.stepKey === undefined,
  );

  const openWizardCreate = () => {
    setWizardInitial(undefined);
    setWizardOpen(true);
  };

  const openWizardEdit = (source: SourceEncoded) => {
    setWizardInitial(source as WorkflowSourceConfig);
    setWizardOpen(true);
  };

  const handleWizardSave = (source: WorkflowSourceConfig) => {
    const sourceId = String(source.id);
    onMutate((model) => {
      const current = model.definition.sources ?? [];
      const existingIndex = current.findIndex((s) => String(s.id) === sourceId);
      const next =
        existingIndex === -1
          ? [...current, source]
          : current.map((s, i) => (i === existingIndex ? source : s));
      return {
        ...model,
        definition: { ...model.definition, sources: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
  };

  const handleRemove = (sourceId: string) => {
    onMutate((model) => {
      const next = (model.definition.sources ?? []).filter((s) => String(s.id) !== sourceId);
      return {
        ...model,
        definition: { ...model.definition, sources: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
  };

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <SourceWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        mode={wizardInitial !== undefined ? "edit" : "create"}
        {...(wizardInitial !== undefined ? { initial: wizardInitial } : {})}
        lanes={lanes}
        listWorkSourceConnections={listWorkSourceConnections}
        createWorkSourceConnection={createWorkSourceConnection}
        disabled={disabled}
        onSave={handleWizardSave}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Work Sources</h4>
          <p className="text-xs text-muted-foreground">
            External issue trackers that create tickets automatically.
          </p>
        </div>
        <Button size="xs" variant="outline" disabled={disabled} onClick={openWizardCreate}>
          <PlusIcon className="size-3.5" />
          Add source
        </Button>
      </div>

      {sourceLintErrors.length > 0 ? (
        <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
          {sourceLintErrors.map((e) => (
            <li key={lintErrorKey(e)}>{e.message}</li>
          ))}
        </ul>
      ) : null}

      {connectionsError ? (
        <p className="text-xs text-destructive">{connectionsError}</p>
      ) : connections === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Loading connections…
        </p>
      ) : null}

      {sources.length === 0 ? (
        <div className="rounded-md border border-border/70 bg-muted/20 p-3">
          <p className="text-sm text-muted-foreground">
            No sources configured. Tickets will only be created manually.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            className="mt-2"
            onClick={openWizardCreate}
          >
            <PlusIcon className="size-3.5" />
            Set up a source
          </Button>
        </div>
      ) : (
        <ol className="space-y-3">
          {sources.map((source) => {
            const sourceId = String(source.id);
            return (
              <li
                key={sourceId}
                className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3"
              >
                <SourceRow
                  source={source}
                  connections={connections ?? []}
                  disabled={disabled}
                  onEdit={() => openWizardEdit(source)}
                  onRemove={() => handleRemove(sourceId)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ─── SourceRow ────────────────────────────────────────────────────────────────

function SourceRow({
  source,
  connections,
  disabled,
  onEdit,
  onRemove,
}: {
  readonly source: SourceEncoded;
  readonly connections: ReadonlyArray<WorkSourceConnectionView>;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const connection = connections.find((c) => c.connectionRef === String(source.connectionRef));
  const connectionLabel = connection?.displayName ?? String(source.connectionRef);

  // Scope summary — provider-specific short description via shared decode helper
  const selectorDraft = decodeSelectorDraft(source);
  let scopeSummary = "";
  if (selectorDraft.provider === "github") {
    const { owner, repo } = selectorDraft.github;
    scopeSummary = owner && repo ? `${owner}/${repo}` : owner || repo || "—";
  } else if (selectorDraft.provider === "asana") {
    const { projectGid } = selectorDraft.asana;
    scopeSummary = projectGid ? `Project ${projectGid}` : "—";
  } else if (selectorDraft.provider === "jira") {
    const { projectKey, jql } = selectorDraft.jira;
    scopeSummary = projectKey ? (jql.trim() ? `${projectKey} · JQL` : projectKey) : "—";
  }

  // Auto-pull badge
  const effectiveRule = effectiveAutoPullRule(source);
  const isAuto = effectiveRule !== null;
  const decodedRule = isAuto ? decodeAutoPullRule(effectiveRule) : null;
  const autoPullSummary = isAuto
    ? decodedRule !== null
      ? summarizeAutoPull(decodedRule)
      : "Active (advanced rule)"
    : "Manual only";

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">
            {source.provider} — {connectionLabel}
          </p>
          <Badge size="sm" variant={isAuto ? "success" : "outline"}>
            {isAuto ? "Auto" : "Manual"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {scopeSummary ? scopeSummary + " · " : ""}→ {String(source.destinationLane)} · closed:{" "}
          {String(source.closedLane)}
        </p>
        {isAuto ? <p className="text-[11px] text-muted-foreground">{autoPullSummary}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          aria-label={`Edit ${source.provider} — ${connectionLabel}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="icon-xs"
          variant="destructive-outline"
          disabled={disabled}
          aria-label={`Remove ${source.provider} — ${connectionLabel}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
