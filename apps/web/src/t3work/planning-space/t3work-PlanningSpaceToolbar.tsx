/**
 * The planning-space toolbar: grouping switch, assign/spotlight hint, filter
 * toggle + counts, and the collapsible filter bar (text search, planning-state
 * chips, epic spotlight chips, focus, clear). Extracted from
 * t3work-PlanningSpaceView.tsx.
 */

import { Shrink, SlidersHorizontal } from "lucide-react";

import type { PlanningSpaceController } from "./t3work-usePlanningSpaceController";
import { GROUPINGS, epicColor } from "./t3work-planningSpaceViewConstants";

export function PlanningSpaceToolbar({ c }: { c: PlanningSpaceController }) {
  const { vm } = c;
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border/70 bg-background/90 p-0.5">
          {GROUPINGS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => c.setGrouping(option.value)}
              className={
                option.value === c.grouping
                  ? "rounded px-2.5 py-1 text-[11px] font-medium bg-accent text-foreground"
                  : "rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {c.assignTarget
            ? `Pick an owner for ${c.assignTarget.kind === "story" ? c.assignTarget.storyId : "the subtask"} · Esc cancels`
            : c.spotlight
              ? "Spotlight active · click the anchor again or press Esc to clear"
              : ""}
        </span>
        <button
          type="button"
          aria-label="Toggle filters"
          aria-expanded={c.showFilters}
          onClick={() => c.setShowFilters((value) => !value)}
          className={`relative ml-auto inline-flex size-7 items-center justify-center rounded-md border text-[12px] ${
            c.showFilters || vm.filtersActive
              ? "border-primary/60 text-primary"
              : "border-border/60 text-muted-foreground hover:text-foreground"
          }`}
        >
          <SlidersHorizontal className="size-3.5" />
          {vm.filtersActive ? (
            <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-medium text-background">
              {(c.textFilter.trim() ? 1 : 0) + c.stateFilters.size + (c.spotlight ? 1 : 0)}
            </span>
          ) : null}
        </button>
        <span className="text-[11px] text-muted-foreground">
          {vm.data.stories.filter((s) => s.inSprint).length} in sprint ·{" "}
          {vm.data.stories.filter((s) => s.isContextParent).length} context · {vm.data.epics.length}{" "}
          epics
        </span>
      </div>
      <div
        className={`flex flex-wrap items-center gap-1.5 px-4 sm:px-6 ${c.showFilters ? "" : "hidden"}`}
      >
        <input
          value={c.textFilter}
          onChange={(event) => c.setTextFilter(event.target.value)}
          placeholder="Search key or title…"
          className="h-7 w-48 rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary/50"
          data-testid="planning-space-search"
        />
        {(
          [
            ["ready", "Ready", "#10b981"],
            ["needs-owner", "Needs owner", "#f59e0b"],
            ["needs-estimate", "Needs estimate", "#ec4899"],
            ["needs-owner-and-estimate", "Needs both", "#ef4444"],
          ] as const
        ).map(([value, label, color]) => {
          const active = c.stateFilters.has(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() =>
                c.setStateFilters((current) => {
                  const next = new Set(current);
                  if (next.has(value)) next.delete(value);
                  else next.add(value);
                  return next;
                })
              }
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                active
                  ? "border-primary/70 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="size-1.5 rounded-full" style={{ background: color }} />
              {label}
            </button>
          );
        })}
        <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden="true" />
        {vm.data.epicOrder.map((epicId) => {
          const epic = vm.epicById.get(epicId);
          if (!epic) return null;
          const active = c.spotlight?.kind === "epic" && c.spotlight.epicId === epicId;
          const color = epicColor(epicId, vm.data.epicOrder);
          return (
            <button
              key={epicId}
              type="button"
              title={`${epic.title} — spotlight this epic's work`}
              onClick={() => {
                const next = active ? null : ({ kind: "epic", epicId } as const);
                c.machineState.current = { ...c.machineState.current, spotlight: next };
                c.setSpotlight(next);
              }}
              className={`inline-flex max-w-36 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                active
                  ? "border-primary/70 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
              <span className="truncate">{epic.key}</span>
            </button>
          );
        })}
        <span className="mx-0.5 h-4 w-px bg-border/70" aria-hidden="true" />
        <button
          type="button"
          onClick={() => c.setSolo((value) => !value)}
          title="Focus: collapse filtered-out items away so only matches stay, packed together (off = mute in place)"
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
            c.solo
              ? "border-primary/70 text-primary"
              : "border-border/60 text-muted-foreground hover:text-foreground"
          }`}
        >
          <Shrink className="size-3" />
          Focus
        </button>
        {vm.filtersActive ? (
          <button
            type="button"
            onClick={() => {
              c.setTextFilter("");
              c.setStateFilters(new Set());
              c.machineState.current = { ...c.machineState.current, spotlight: null };
              c.setSpotlight(null);
            }}
            className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Clear ({vm.storyMatches.size} match{vm.storyMatches.size === 1 ? "" : "es"})
          </button>
        ) : null}
      </div>
    </>
  );
}
