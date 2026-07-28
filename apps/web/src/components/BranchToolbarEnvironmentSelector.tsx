import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  environmentAccentStyle,
  resolveEnvironmentAccentColor,
  useEnvironmentAccentColors,
  type EnvironmentAccentColors,
} from "../environmentAccentColors";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

function EnvironmentIcon({
  accentColors,
  environment,
}: {
  readonly accentColors: EnvironmentAccentColors;
  readonly environment: EnvironmentOption | null;
}) {
  const accentColor = resolveEnvironmentAccentColor(accentColors, environment?.environmentId);
  const Icon = environment?.isPrimary ? MonitorIcon : CloudIcon;
  return <Icon className="size-3 shrink-0" style={environmentAccentStyle(accentColor)} />;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const accentColors = useEnvironmentAccentColors();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        <EnvironmentIcon accentColors={accentColors} environment={activeEnvironment} />
        <span className="truncate">{activeEnvironment?.label ?? "Run on"}</span>
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-full font-medium"
        aria-label="Run on"
      >
        <EnvironmentIcon accentColors={accentColors} environment={activeEnvironment} />
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentIcon accentColors={accentColors} environment={env} />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
