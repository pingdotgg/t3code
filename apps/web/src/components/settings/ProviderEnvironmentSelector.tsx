import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { useMemo } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface ProviderEnvironmentSelectorProps {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export function ProviderEnvironmentSelector({
  environmentId,
  environments,
  primaryEnvironmentId,
  onEnvironmentChange,
}: ProviderEnvironmentSelectorProps) {
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  const items = useMemo(
    () =>
      environments.map((environment) => ({
        value: environment.environmentId,
        label: environment.label,
      })),
    [environments],
  );

  return (
    <Select
      value={environmentId}
      items={items}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
    >
      <SelectTrigger
        size="sm"
        className="w-36 sm:w-52"
        aria-label="Configure providers on environment"
      >
        {environmentId === primaryEnvironmentId ? (
          <MonitorIcon className="size-3.5" />
        ) : (
          <CloudIcon className="size-3.5" />
        )}
        <SelectValue>{selectedEnvironment?.label ?? "Select environment"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectGroupLabel>Configure providers on</SelectGroupLabel>
          {environments.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {environment.environmentId === primaryEnvironmentId ? (
                  <MonitorIcon className="size-3.5" />
                ) : (
                  <CloudIcon className="size-3.5" />
                )}
                {environment.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}
