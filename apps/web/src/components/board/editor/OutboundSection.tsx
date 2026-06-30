import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  OutboundConnectionView,
  WorkflowDefinitionEncoded,
  WorkflowLintError,
} from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { lintErrorKey } from "~/workflow/editorModel";
import type { WorkflowEditorMutation } from "./WorkflowEditor";

// ─── types ───────────────────────────────────────────────────────────────────

type OutboundRuleEncoded = NonNullable<WorkflowDefinitionEncoded["outbound"]>[number];

type OutboundTrigger = "needs_attention" | "blocked" | "done" | "lane_entered";
type OutboundFormatter = "generic" | "slack";

interface OutboundRuleDraft {
  id: string;
  on: OutboundTrigger;
  when: string; // raw JSON string; empty = undefined
  to: string; // connectionRef
  as: OutboundFormatter;
  enabled: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<OutboundTrigger, string> = {
  needs_attention: "Needs attention",
  blocked: "Blocked",
  done: "Done",
  lane_entered: "Lane entered",
};

const FORMATTER_LABELS: Record<OutboundFormatter, string> = {
  generic: "Generic",
  slack: "Slack",
};

function newRuleDraft(): OutboundRuleDraft {
  return {
    id: `outbound-${Date.now()}`,
    on: "done",
    when: "",
    to: "",
    as: "generic",
    enabled: true,
  };
}

function ruleToDraft(rule: OutboundRuleEncoded): OutboundRuleDraft {
  return {
    id: String(rule.id),
    on: rule.on as OutboundTrigger,
    when: rule.when !== undefined ? JSON.stringify(rule.when, null, 2) : "",
    to: String(rule.to),
    as: rule.as as OutboundFormatter,
    enabled: rule.enabled,
  };
}

function draftToRule(draft: OutboundRuleDraft): OutboundRuleEncoded {
  let when: unknown = undefined;
  if (draft.when.trim()) {
    try {
      when = JSON.parse(draft.when) as unknown;
    } catch {
      // leave undefined if unparseable; server lint will surface the error
    }
  }
  return {
    id: draft.id as never,
    on: draft.on,
    ...(when !== undefined ? { when } : {}),
    to: draft.to as never,
    as: draft.as,
    enabled: draft.enabled,
  };
}

// ─── component ───────────────────────────────────────────────────────────────

export interface OutboundSectionProps {
  readonly definition: WorkflowDefinitionEncoded;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
  readonly listOutboundConnections: (
    input: Record<string, never>,
  ) => Promise<{ readonly connections: ReadonlyArray<OutboundConnectionView> }>;
}

export function OutboundSection({
  definition,
  lintErrors,
  disabled = false,
  onMutate,
  listOutboundConnections,
}: OutboundSectionProps) {
  const [connections, setConnections] = useState<ReadonlyArray<OutboundConnectionView> | null>(
    null,
  );
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draftRule, setDraftRule] = useState<OutboundRuleDraft | null>(null);

  useEffect(() => {
    let active = true;
    setConnections(null);
    setConnectionsError(null);
    listOutboundConnections({})
      .then((result) => {
        if (active) setConnections(result.connections);
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
  }, [listOutboundConnections]);

  const rules = definition.outbound ?? [];

  // Outbound lint errors have no laneKey / stepKey
  const outboundLintErrors = lintErrors.filter(
    (e) =>
      (e.code === "invalid_outbound" || e.code === "duplicate_outbound_id") &&
      e.laneKey === undefined &&
      e.stepKey === undefined,
  );

  const handleAdd = () => {
    const draft = newRuleDraft();
    setDraftRule(draft);
    setEditingRuleId(draft.id);
  };

  const handleEdit = (rule: OutboundRuleEncoded) => {
    setDraftRule(ruleToDraft(rule));
    setEditingRuleId(String(rule.id));
  };

  const handleSaveDraft = () => {
    if (!draftRule) return;
    const ruleId = draftRule.id;
    const encoded = draftToRule(draftRule);
    onMutate((model) => {
      const current = model.definition.outbound ?? [];
      const existingIndex = current.findIndex((r) => String(r.id) === ruleId);
      const next =
        existingIndex === -1
          ? [...current, encoded]
          : current.map((r, i) => (i === existingIndex ? encoded : r));
      return {
        ...model,
        definition: { ...model.definition, outbound: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
    setEditingRuleId(null);
    setDraftRule(null);
  };

  const handleCancelDraft = () => {
    setEditingRuleId(null);
    setDraftRule(null);
  };

  const handleRemove = (ruleId: string) => {
    onMutate((model) => {
      const next = (model.definition.outbound ?? []).filter((r) => String(r.id) !== ruleId);
      return {
        ...model,
        definition: { ...model.definition, outbound: next as never },
        dirty: true,
        lintErrors: [],
      };
    });
    if (editingRuleId === ruleId) {
      setEditingRuleId(null);
      setDraftRule(null);
    }
  };

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Outbound Rules</h4>
          <p className="text-xs text-muted-foreground">
            Send notifications to external services when tickets change state.
          </p>
        </div>
        <Button size="xs" variant="outline" disabled={disabled} onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add rule
        </Button>
      </div>

      {outboundLintErrors.length > 0 ? (
        <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
          {outboundLintErrors.map((e) => (
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

      {rules.length === 0 && editingRuleId === null ? (
        <p className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
          No outbound rules configured. Events will only be visible in t3code.
        </p>
      ) : (
        <ol className="space-y-3">
          {rules.map((rule) => {
            const ruleId = String(rule.id);
            const isEditing = editingRuleId === ruleId;
            return (
              <li
                key={ruleId}
                className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3"
              >
                {isEditing && draftRule ? (
                  <OutboundRuleForm
                    draft={draftRule}
                    connections={connections ?? []}
                    disabled={disabled}
                    onChange={setDraftRule}
                    onSave={handleSaveDraft}
                    onCancel={handleCancelDraft}
                    onRemove={() => handleRemove(ruleId)}
                    isNew={false}
                  />
                ) : (
                  <OutboundRuleRow
                    rule={rule}
                    connections={connections ?? []}
                    disabled={disabled}
                    onEdit={() => handleEdit(rule)}
                    onRemove={() => handleRemove(ruleId)}
                  />
                )}
              </li>
            );
          })}
          {editingRuleId !== null &&
          !rules.some((r) => String(r.id) === editingRuleId) &&
          draftRule ? (
            <li className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3">
              <OutboundRuleForm
                draft={draftRule}
                connections={connections ?? []}
                disabled={disabled}
                onChange={setDraftRule}
                onSave={handleSaveDraft}
                onCancel={handleCancelDraft}
                onRemove={null}
                isNew
              />
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

// ─── OutboundRuleRow ─────────────────────────────────────────────────────────

function OutboundRuleRow({
  rule,
  connections,
  disabled,
  onEdit,
  onRemove,
}: {
  readonly rule: OutboundRuleEncoded;
  readonly connections: ReadonlyArray<OutboundConnectionView>;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const connection = connections.find((c) => c.connectionRef === String(rule.to));
  const connectionLabel = connection?.displayName ?? String(rule.to);
  const triggerLabel = TRIGGER_LABELS[rule.on as OutboundTrigger] ?? String(rule.on);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-medium text-foreground">
          {triggerLabel} → {connectionLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          formatter: {String(rule.as)}
          {!rule.enabled ? " · disabled" : null}
          {rule.when !== undefined ? " · has condition" : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          aria-label={`Edit ${triggerLabel} → ${connectionLabel}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="icon-xs"
          variant="destructive-outline"
          disabled={disabled}
          aria-label={`Remove ${triggerLabel} → ${connectionLabel}`}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── OutboundRuleForm ─────────────────────────────────────────────────────────

function OutboundRuleForm({
  draft,
  connections,
  disabled,
  onChange,
  onSave,
  onCancel,
  onRemove,
  isNew,
}: {
  readonly draft: OutboundRuleDraft;
  readonly connections: ReadonlyArray<OutboundConnectionView>;
  readonly disabled: boolean;
  readonly onChange: (next: OutboundRuleDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onRemove: (() => void) | null;
  readonly isNew: boolean;
}) {
  const whenParseError =
    draft.when.trim() !== ""
      ? (() => {
          try {
            JSON.parse(draft.when);
            return null;
          } catch {
            return "Invalid JSON";
          }
        })()
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {isNew ? "New outbound rule" : "Edit outbound rule"}
        </span>
        {onRemove ? (
          <Button
            size="icon-xs"
            variant="destructive-outline"
            disabled={disabled}
            aria-label="Remove outbound rule"
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {/* Trigger */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Trigger</span>
        <select
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={draft.on}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, on: e.currentTarget.value as OutboundTrigger })}
        >
          {(Object.entries(TRIGGER_LABELS) as [OutboundTrigger, string][]).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {/* Destination connection */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Connection</span>
        <select
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={draft.to}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, to: e.currentTarget.value })}
        >
          <option value="">— select connection —</option>
          {connections.map((c) => (
            <option key={c.connectionRef} value={c.connectionRef}>
              {c.displayName}
            </option>
          ))}
        </select>
        {connections.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No outbound connections.{" "}
            <a href="/settings/outbound" className="underline hover:text-foreground">
              Add one in Settings → Outbound
            </a>
            .
          </p>
        ) : null}
      </label>

      {/* Formatter */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">Formatter</span>
        <select
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={draft.as}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, as: e.currentTarget.value as OutboundFormatter })}
        >
          {(Object.entries(FORMATTER_LABELS) as [OutboundFormatter, string][]).map(
            ([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ),
          )}
        </select>
      </label>

      {/* Optional when predicate */}
      <label className="grid gap-1">
        <span className="text-xs font-medium text-foreground">
          Condition (JSON-logic, optional)
        </span>
        <textarea
          className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground disabled:opacity-50"
          value={draft.when}
          placeholder={'{"==": [{"var": "trigger"}, "done"]}'}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, when: e.currentTarget.value })}
          spellCheck={false}
        />
        {whenParseError ? (
          <p className="text-[11px] text-destructive">{whenParseError}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Leave blank to fire on every matching event. Variables: trigger, ticketId, boardId,
            title, status, fromLane, toLane, isTerminal, reason.
          </p>
        )}
      </label>

      {/* Enabled */}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, enabled: e.currentTarget.checked })}
        />
        Enabled
      </label>

      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={disabled || whenParseError !== null} onClick={onSave}>
          {isNew ? "Add rule" : "Save rule"}
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
