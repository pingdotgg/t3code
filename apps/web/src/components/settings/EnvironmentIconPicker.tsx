import {
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

const AUTOMATIC_VALUE = "automatic";

/**
 * Why the picker is inert, in the order the user can do something about it.
 * Null means it can be changed.
 */
export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

// Same split the provider settings use: the desktop app owns its primary
// server outright, a browser session on the primary checks its cookie
// session's scopes, and a remote checks the scopes its own server reports.
function useEnvironmentOperateAccess(environmentId: EnvironmentId) {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(environmentId);
  if (isPrimary) {
    return isElectron
      ? "granted"
      : resolvePrimaryOperateAccess({
          isPrimary: true,
          hasDesktopBridge: false,
          session: primarySession.data,
          isPending: primarySession.isPending,
          hasError: primarySession.error !== null,
        });
  }
  return resolveRemoteOperateAccess({
    session: remoteSession.data,
    isPending: remoteSession.isPending,
    hasError: remoteSession.hasError,
  });
}

/**
 * Picks the machine glyph an environment wears everywhere it is listed.
 * "Automatic" clears the override so the server's own detection shows
 * through; the label says what that currently resolves to so the user can
 * tell whether detection got it right before overriding. The control stays
 * visible while locked so the current icon still reads, the same way
 * server-scoped rows go inert instead of disappearing.
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
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
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

  const select = (
    <Select value={value} onValueChange={handleValueChange} disabled={lock !== null}>
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

  if (lock === null) {
    return select;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // Focusable so keyboard users can still reach the explanation.
          <span
            tabIndex={0}
            className="flex w-full items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
          />
        }
      >
        <span className="flex w-full items-center sm:w-auto">{select}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {lock}
      </TooltipPopup>
    </Tooltip>
  );
}
