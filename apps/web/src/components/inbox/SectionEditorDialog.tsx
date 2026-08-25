/**
 * Defining a section. Everything here narrows: leave a row untouched and it
 * does not filter, so the reader builds a section by saying only what they
 * care about. The live count under the name is the whole point — you should
 * know what a section catches before you keep it.
 */
import type { PostHogInboxFilter, PostHogInboxSection, PostHogReport } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { sourceProductLabel, reportStateLabel } from "./inboxList.logic";
import { EMPTY_INBOX_FILTER, isEmptyFilter, matchesFilter } from "./inboxSections.logic";

const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
const STATUSES = ["ready", "pending_input", "in_progress", "candidate", "potential", "failed"];
const ACTIONABILITIES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "immediately_actionable", label: "Can be fixed now" },
  { value: "requires_human_input", label: "Needs your input" },
  { value: "not_actionable", label: "Not actionable" },
];

function ChipToggle({
  active,
  children,
  onClick,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FilterRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-start gap-3">
      <span className="pt-1 text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function TriState({
  value,
  labels,
  onChange,
}: {
  readonly value: boolean | null | undefined;
  readonly labels: readonly [string, string, string];
  readonly onChange: (next: boolean | null) => void;
}) {
  const options: ReadonlyArray<{ readonly value: boolean | null; readonly label: string }> = [
    { value: null, label: labels[0] },
    { value: true, label: labels[1] },
    { value: false, label: labels[2] },
  ];
  return (
    <>
      {options.map((option) => (
        <ChipToggle
          key={option.label}
          active={(value ?? null) === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </ChipToggle>
      ))}
    </>
  );
}

function toggleIn(list: ReadonlyArray<string>, value: string): ReadonlyArray<string> {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function SectionEditorDialog({
  open,
  onOpenChange,
  section,
  reports,
  onSave,
  onDelete,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The section being edited, or null when creating one. */
  readonly section: PostHogInboxSection | null;
  /** Every open report, so the editor can count what the filter would catch. */
  readonly reports: ReadonlyArray<PostHogReport>;
  readonly onSave: (label: string, filter: PostHogInboxFilter) => void;
  readonly onDelete: (() => void) | null;
}) {
  const [label, setLabel] = useState(section?.label ?? "");
  const [filter, setFilter] = useState<PostHogInboxFilter>(section?.filter ?? EMPTY_INBOX_FILTER);

  // Only products actually present are offered: a filter on a source this
  // project never emits is a section that stays empty forever.
  const availableProducts = useMemo(() => {
    const seen = new Set<string>();
    for (const report of reports) for (const product of report.source_products) seen.add(product);
    return [...seen].sort();
  }, [reports]);

  const matchCount = useMemo(
    () => reports.filter((report) => matchesFilter(report, filter)).length,
    [filter, reports],
  );

  const patch = (next: Partial<PostHogInboxFilter>) =>
    setFilter((current) => ({ ...current, ...next }));

  const trimmedLabel = label.trim();
  const canSave = trimmedLabel.length > 0 && !isEmptyFilter(filter);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{section ? "Edit section" : "New section"}</DialogTitle>
          <DialogDescription>
            Sections you define come before the built-in ones, and each report lands in the first
            section that keeps it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          <div className="grid grid-cols-[7rem_1fr] items-center gap-3">
            <Label htmlFor="section-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="section-name"
              value={label}
              autoFocus
              placeholder="My P0s"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>

          <FilterRow label="Priority">
            {PRIORITIES.map((priority) => (
              <ChipToggle
                key={priority}
                active={filter.priorities.includes(priority)}
                onClick={() => patch({ priorities: toggleIn(filter.priorities, priority) })}
              >
                {priority}
              </ChipToggle>
            ))}
          </FilterRow>

          <FilterRow label="State">
            {STATUSES.map((status) => (
              <ChipToggle
                key={status}
                active={filter.statuses.includes(status)}
                onClick={() => patch({ statuses: toggleIn(filter.statuses, status) })}
              >
                {reportStateLabel(status)}
              </ChipToggle>
            ))}
          </FilterRow>

          <FilterRow label="Actionability">
            {ACTIONABILITIES.map((entry) => (
              <ChipToggle
                key={entry.value}
                active={filter.actionabilities.includes(entry.value)}
                onClick={() =>
                  patch({ actionabilities: toggleIn(filter.actionabilities, entry.value) })
                }
              >
                {entry.label}
              </ChipToggle>
            ))}
          </FilterRow>

          {availableProducts.length > 0 ? (
            <FilterRow label="Source">
              {availableProducts.map((product) => (
                <ChipToggle
                  key={product}
                  active={filter.sourceProducts.includes(product)}
                  onClick={() =>
                    patch({ sourceProducts: toggleIn(filter.sourceProducts, product) })
                  }
                >
                  {sourceProductLabel(product)}
                </ChipToggle>
              ))}
            </FilterRow>
          ) : null}

          <FilterRow label="Reviewer">
            <TriState
              value={filter.forYou}
              labels={["Anyone", "You", "Not you"]}
              onChange={(next) => patch({ forYou: next })}
            />
          </FilterRow>

          <FilterRow label="Pull request">
            <TriState
              value={filter.hasPullRequest}
              labels={["Either", "Open", "None"]}
              onChange={(next) => patch({ hasPullRequest: next })}
            />
          </FilterRow>

          <div className="grid grid-cols-[7rem_1fr] items-center gap-3">
            <Label htmlFor="section-title" className="text-xs text-muted-foreground">
              Title contains
            </Label>
            <Input
              id="section-title"
              value={filter.titleContains}
              placeholder="billing"
              onChange={(event) => patch({ titleContains: event.target.value })}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {isEmptyFilter(filter)
              ? "Narrow it by at least one thing — an empty section would swallow the whole inbox."
              : `Catches ${matchCount} of ${reports.length} open ${
                  reports.length === 1 ? "report" : "reports"
                } right now.`}
          </p>
        </div>

        <DialogFooter>
          {onDelete ? (
            <Button
              variant="ghost"
              className="me-auto text-destructive"
              onClick={() => {
                onDelete();
                onOpenChange(false);
              }}
            >
              Delete section
            </Button>
          ) : null}
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave(trimmedLabel, filter);
              onOpenChange(false);
            }}
          >
            {section ? "Save section" : "Add section"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
