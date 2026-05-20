import type { TurnDiffScope } from "@t3tools/contracts";
import { GitCommitVerticalIcon, LayersIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

interface DiffScopeToggleProps {
  value: TurnDiffScope;
  onChange: (scope: TurnDiffScope) => void;
  className?: string;
}

/** Compact icon-based toggle for switching between turn-only and snapshot diff scopes. */
export function DiffScopeToggle({ value, onChange, className }: DiffScopeToggleProps) {
  return (
    <ToggleGroup
      className={cn(
        "[&_button]:!h-[1.5em] [&_button]:!min-w-[1.5em] [&_button]:!px-[0.2em]",
        className,
      )}
      variant="outline"
      size="xs"
      value={[value]}
      onValueChange={(next) => {
        const scope = next[0];
        if (scope === "turn" || scope === "snapshot") {
          onChange(scope);
        }
      }}
    >
      <Toggle aria-label="Show changes from this turn only" title="Turn" value="turn">
        <GitCommitVerticalIcon className="!size-[0.85em]" />
      </Toggle>
      <Toggle
        aria-label="Show all changes since the prior snapshot"
        title="Snapshot"
        value="snapshot"
      >
        <LayersIcon className="!size-[0.85em]" />
      </Toggle>
    </ToggleGroup>
  );
}
