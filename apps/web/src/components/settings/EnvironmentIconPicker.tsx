import {
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const AUTOMATIC_VALUE = "automatic";

/**
 * Picks the machine glyph an environment wears everywhere it is listed.
 * "Automatic" clears the override so the server's own detection shows
 * through; the label says what that currently resolves to so the user can
 * tell whether detection got it right before overriding.
 */
export function EnvironmentIconPicker({
  environmentId,
  serverConfig,
  size = "sm",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly size?: "xs" | "sm";
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const override = serverConfig?.settings.environmentIcon ?? null;
  const detected = serverConfig?.environment.platform.machine ?? null;
  const resolved = resolveEnvironmentMachineKind(serverConfig);
  const value = override ?? AUTOMATIC_VALUE;
  const automaticLabel =
    detected === null ? "Automatic" : `Automatic (${ENVIRONMENT_MACHINE_KIND_LABELS[detected]})`;

  const handleValueChange = useCallback(
    (next: string | null) => {
      if (next === null) return;
      if (next === AUTOMATIC_VALUE) {
        updateSettings({ environmentIcon: null });
      } else if (isEnvironmentMachineKind(next)) {
        updateSettings({ environmentIcon: next });
      }
    },
    [updateSettings],
  );

  return (
    <Select value={value} onValueChange={handleValueChange} disabled={serverConfig === null}>
      <SelectTrigger size={size} className="w-full sm:w-52" aria-label="Environment icon">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon kind={resolved} className="size-3.5 shrink-0" />
            <span className="truncate">
              {override === null ? automaticLabel : ENVIRONMENT_MACHINE_KIND_LABELS[override]}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={AUTOMATIC_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon kind={detected ?? "server"} className="size-3.5 shrink-0" />
            <span className="truncate">{automaticLabel}</span>
          </span>
        </SelectItem>
        {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
          <SelectItem hideIndicator key={kind} value={kind}>
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
              <span className="truncate">{ENVIRONMENT_MACHINE_KIND_LABELS[kind]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
