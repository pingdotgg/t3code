/**
 * Team rail (spec §6.6): bottom HUD with one dock per member + Unassigned.
 * Docks are group anchors per the §6.1 contract — click = spotlight,
 * double-click = frame the member, drop = assign — wired through the same
 * hit-testing as everything else via data attributes. Capacity arcs show
 * live load against the configured per-person capacity (Tempo later, §10.2).
 */

import { ChevronDown, ChevronUp } from "lucide-react";

import type { PlanningOwner } from "./t3work-planningSpaceData";
import { initialsOf, ownerColor } from "./t3work-planningSpaceViewConstants";
import { groupOwnersByRole } from "./t3work-planningSpaceRailGrouping";

export const UNASSIGNED_DOCK_ID = "__unassigned_dock__";

function formatHours(seconds: number): string {
  if (seconds <= 0) return "0h";
  const hours = seconds / 3600;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

const ARC_RADIUS = 16;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

export function PlanningSpaceRail({
  owners,
  unassignedCount,
  capacitySeconds,
  ownerCapacities,
  open,
  lifted,
  spotlightOwnerId,
  ownerRoles,
  onToggle,
}: {
  owners: ReadonlyArray<PlanningOwner>;
  unassignedCount: number;
  /** Fallback capacity when Tempo has no entry for an owner. */
  capacitySeconds: number;
  /** Tempo-derived capacity per owner accountId for the sprint window (§10.2). */
  ownerCapacities?: ReadonlyMap<string, number> | undefined;
  open: boolean;
  lifted: boolean;
  spotlightOwnerId: string | null | undefined;
  ownerRoles?: ReadonlyMap<string, string> | undefined;
  onToggle: () => void;
}) {
  const roleGroups = groupOwnersByRole(owners, ownerRoles);
  return (
    <div
      className="group/rail absolute inset-x-0 bottom-0 z-20 transition-transform duration-300"
      style={{ transform: open ? "none" : "translateY(calc(100% - 0px))" }}
      data-testid="planning-space-rail"
    >
      <button
        type="button"
        data-ps-chrome="true"
        aria-label={open ? "Collapse team row" : "Expand team row"}
        onClick={onToggle}
        className="absolute -top-6 left-1/2 flex h-6 w-12 -translate-x-1/2 items-center justify-center text-[11px] text-muted-foreground opacity-0 transition-opacity duration-200 hover:text-foreground hover:opacity-100 group-hover/rail:opacity-100 focus-visible:opacity-100"
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronUp className="size-4" />
        )}
      </button>
      <div className="flex gap-1 overflow-x-auto bg-gradient-to-t from-background via-background/90 to-transparent px-3 pb-1.5 pt-2">
        {roleGroups.flatMap((group, groupIndex) => [
          group.role !== null ? (
            <div
              key={`role:${group.role}`}
              className={`flex shrink-0 flex-col items-center justify-end gap-1 pb-1 ${
                groupIndex > 0 ? "ml-1.5 border-l border-border/50 pl-1.5" : ""
              }`}
              aria-hidden="true"
            >
              <span
                className="text-[7px] uppercase tracking-wider text-muted-foreground/70"
                style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
              >
                {group.role}
              </span>
            </div>
          ) : groupIndex > 0 ? (
            <div
              key="role:none"
              className="ml-1.5 shrink-0 border-l border-border/50 pl-1.5"
              aria-hidden="true"
            />
          ) : null,
          ...group.owners.map((owner) => {
          const color = ownerColor(owner.id);
          const ownerCapacity = ownerCapacities?.get(owner.id) ?? capacitySeconds;
          const ratio = ownerCapacity > 0 ? owner.loadSeconds / ownerCapacity : 0;
          const over = ratio > 1;
          const arcLength = Math.min(ratio, 1) * ARC_CIRCUMFERENCE;
          const isSpotlit = spotlightOwnerId === owner.id;
          const capacitySource = ownerCapacities?.has(owner.id)
            ? "Tempo availability for the sprint window"
            : "default capacity";
          return (
            <div
              key={owner.id}
              data-dock={owner.id}
              className={`flex w-14 shrink-0 cursor-pointer flex-col items-center rounded-md pb-0.5 transition-transform ${
                lifted ? "-translate-y-1.5" : ""
              } ${isSpotlit ? "bg-accent/60" : "hover:bg-accent/40"}`}
              title={`${owner.name} — assigned ${formatHours(owner.loadSeconds)}, remaining ${formatHours(owner.remainingSeconds)}, ${formatHours(ownerCapacity)} available (${capacitySource}). Click to spotlight, drag onto an item to assign.`}
            >
              <span className="relative flex size-10 items-center justify-center">
                <svg width="40" height="40" className="absolute inset-0" aria-hidden="true">
                  <circle
                    cx="20"
                    cy="20"
                    r={ARC_RADIUS}
                    fill="none"
                    strokeWidth="2.5"
                    className="stroke-border"
                  />
                  <circle
                    cx="20"
                    cy="20"
                    r={ARC_RADIUS}
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    stroke={over ? "#ef4444" : "#10b981"}
                    strokeDasharray={`${arcLength} ${ARC_CIRCUMFERENCE}`}
                    transform="rotate(-90 20 20)"
                    style={{ transition: "stroke-dasharray .4s, stroke .4s" }}
                  />
                </svg>
                <span
                  className={`flex size-6 items-center justify-center rounded-full text-[8.5px] font-medium text-background ${
                    isSpotlit ? "ring-2 ring-primary ring-offset-1" : ""
                  }`}
                  style={{ background: color }}
                >
                  {initialsOf(owner.name)}
                </span>
              </span>
              <span className="max-w-13 truncate text-[8.5px] text-foreground/85">
                {owner.name.split(" ")[0]}
              </span>
              <span
                className={`text-[7.5px] tabular-nums ${
                  over ? "text-red-500" : "text-muted-foreground"
                }`}
              >
                {formatHours(owner.loadSeconds)}/{formatHours(ownerCapacity)}
              </span>
            </div>
          );
          }),
        ])}
        <div
          data-dock={UNASSIGNED_DOCK_ID}
          className={`flex w-14 shrink-0 cursor-pointer flex-col items-center rounded-md pb-0.5 transition-transform ${
            lifted ? "-translate-y-1.5" : ""
          } ${spotlightOwnerId === null ? "bg-accent/60" : "hover:bg-accent/40"}`}
          title="Unassigned — click to spotlight, drop here to unassign"
        >
          <span className="relative flex size-10 items-center justify-center">
            <span
              className={`flex size-6 items-center justify-center rounded-full border border-dashed border-muted-foreground text-[10px] text-muted-foreground ${
                spotlightOwnerId === null ? "ring-2 ring-primary ring-offset-1" : ""
              }`}
            >
              ?
            </span>
          </span>
          <span className="text-[8.5px] text-foreground/85">None</span>
          <span className="text-[7.5px] tabular-nums text-muted-foreground">
            {unassignedCount} open
          </span>
        </div>
      </div>
    </div>
  );
}
