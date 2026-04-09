import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, FolderIcon, ServerIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironmentLabel = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId)?.label ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        <ServerIcon className="size-3" />
        {activeEnvironmentLabel ?? "Environment"}
      </span>
    );
  }

  return (
    <Select
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <SelectTrigger variant="ghost" size="xs" className="font-medium">
        <ServerIcon className="size-3" />
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {availableEnvironments.map((env) => (
          <SelectItem key={env.environmentId} value={env.environmentId}>
            <span className="inline-flex items-center gap-1.5">
              {env.isPrimary ? <FolderIcon className="size-3" /> : <CloudIcon className="size-3" />}
              {env.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
});
