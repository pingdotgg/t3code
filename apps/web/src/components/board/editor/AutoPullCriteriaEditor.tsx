import { XIcon } from "lucide-react";

import { summarizeAutoPull, type AutoPullCriteria } from "@t3tools/contracts/workSource";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

// ─── types ────────────────────────────────────────────────────────────────────

interface AutoPullCriteriaEditorProps {
  /** The current criteria value (controlled). */
  readonly value: AutoPullCriteria;
  /** Called whenever any field changes. */
  readonly onChange: (next: AutoPullCriteria) => void;
  readonly disabled?: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Strip whitespace and deduplicate labels from the chip input. */
function parseLabel(raw: string): string {
  return raw.trim();
}

// ─── component ────────────────────────────────────────────────────────────────

/**
 * Controlled editor for auto-pull criteria.
 *
 * Displays:
 *   - Label chips with any/all toggle
 *   - Assignee selector (none / anyone / specific login)
 *   - State selector (any / open / closed)
 *
 * Imports `AutoPullCriteria`, `compileAutoPullRule`, and `summarizeAutoPull`
 * from `@t3tools/contracts/workSource` (Phase A helpers — already shipped).
 */
export function AutoPullCriteriaEditor({
  value,
  onChange,
  disabled = false,
}: AutoPullCriteriaEditorProps) {
  // Derive summary from current criteria for display purposes
  const summary = summarizeAutoPull(value);

  // ── Labels ──────────────────────────────────────────────────────────────────

  const labels = value.labels?.values ?? [];
  const labelMode = value.labels?.mode ?? "any";

  const handleAddLabel = (raw: string) => {
    const label = parseLabel(raw);
    if (!label || labels.includes(label)) return;
    const next = [...labels, label];
    onChange({
      ...value,
      labels: { mode: labelMode, values: next },
    });
  };

  const handleRemoveLabel = (label: string) => {
    const next = labels.filter((l) => l !== label);
    if (next.length === 0) {
      // Drop the labels key entirely when empty
      const { labels: _labels, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, labels: { mode: labelMode, values: next } });
    }
  };

  const handleLabelModeToggle = (mode: "any" | "all") => {
    if (!value.labels) return;
    onChange({ ...value, labels: { ...value.labels, mode } });
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const input = e.currentTarget;
      handleAddLabel(input.value);
      input.value = "";
    }
  };

  const handleLabelBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const raw = e.currentTarget.value.trim();
    if (raw) {
      handleAddLabel(raw);
      e.currentTarget.value = "";
    }
  };

  // ── Assignee ────────────────────────────────────────────────────────────────

  type AssigneeKind = "none" | "anyone" | "login";

  const assigneeKind: AssigneeKind =
    value.assignee === undefined ? "none" : value.assignee.kind === "anyone" ? "anyone" : "login";

  const assigneeLogin = value.assignee?.kind === "login" ? value.assignee.value : "";

  const handleAssigneeKindChange = (kind: AssigneeKind) => {
    if (kind === "none") {
      const { assignee: _assignee, ...rest } = value;
      onChange(rest);
    } else if (kind === "anyone") {
      onChange({ ...value, assignee: { kind: "anyone" } });
    } else {
      // switch to login mode — keep existing login if there was one
      onChange({ ...value, assignee: { kind: "login", value: assigneeLogin } });
    }
  };

  const handleAssigneeLoginChange = (login: string) => {
    onChange({ ...value, assignee: { kind: "login", value: login } });
  };

  // ── State ───────────────────────────────────────────────────────────────────

  type StateFilter = "any" | "open" | "closed";
  const stateFilter: StateFilter = value.state ?? "any";

  const handleStateChange = (s: StateFilter) => {
    if (s === "any") {
      const { state: _state, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, state: s });
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Summary line */}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Preview: </span>
        {summary}
      </p>

      {/* Labels */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Labels</span>
          {labels.length > 1 ? (
            <div
              role="group"
              aria-label="Label match mode"
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              <button
                type="button"
                disabled={disabled}
                aria-pressed={labelMode === "any"}
                onClick={() => handleLabelModeToggle("any")}
                className={
                  labelMode === "any"
                    ? "font-semibold text-foreground underline"
                    : "hover:text-foreground"
                }
              >
                any
              </button>
              <span>/</span>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={labelMode === "all"}
                onClick={() => handleLabelModeToggle("all")}
                className={
                  labelMode === "all"
                    ? "font-semibold text-foreground underline"
                    : "hover:text-foreground"
                }
              >
                all
              </button>
            </div>
          ) : null}
        </div>

        {/* Chip list */}
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label) => (
            <Badge key={label} variant="outline" className="gap-1 pr-1">
              {label}
              <button
                type="button"
                aria-label={`Remove label ${label}`}
                disabled={disabled}
                onClick={() => handleRemoveLabel(label)}
                className="opacity-60 hover:opacity-100 disabled:pointer-events-none"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>

        {/* Add label input */}
        <Input
          nativeInput
          type="text"
          placeholder="Add label (Enter or comma to add)"
          disabled={disabled}
          onKeyDown={handleLabelKeyDown}
          onBlur={handleLabelBlur}
          aria-label="Add label"
        />
        <p className="text-[11px] text-muted-foreground">
          Press Enter or comma to add. Leave empty to match any label.
        </p>
      </div>

      {/* Assignee */}
      <div className="grid gap-1">
        <label htmlFor="assignee-kind" className="text-xs font-medium text-foreground">
          Assignee
        </label>
        <select
          id="assignee-kind"
          className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={assigneeKind}
          disabled={disabled}
          onChange={(e) => handleAssigneeKindChange(e.currentTarget.value as AssigneeKind)}
        >
          <option value="none">Any (no filter)</option>
          <option value="anyone">Assigned to anyone</option>
          <option value="login">Specific login</option>
        </select>
        {assigneeKind === "login" ? (
          <>
            <label htmlFor="assignee-login" className="text-xs text-muted-foreground">
              GitHub username
            </label>
            <Input
              nativeInput
              id="assignee-login"
              type="text"
              placeholder="GitHub username"
              value={assigneeLogin}
              disabled={disabled}
              onChange={(e) => handleAssigneeLoginChange(e.currentTarget.value)}
            />
          </>
        ) : null}
      </div>

      {/* State */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-foreground">Issue state</legend>
        <div className="flex gap-2">
          {(["any", "open", "closed"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="xs"
              variant={stateFilter === s ? "default" : "outline"}
              disabled={disabled}
              onClick={() => handleStateChange(s)}
            >
              {s === "any" ? "Any" : s.charAt(0).toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
