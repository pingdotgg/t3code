import {
  ENVIRONMENT_MACHINE_KINDS,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

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
 * "Icon" submenu for an environment's row menu. Lists the machine kinds with
 * the server's own detection marked, so the user can tell whether detection
 * got it right before overriding. Picking the detected kind clears the
 * override. Locked environments show the reason as a disabled item instead of
 * hiding the submenu, so the current icon still reads.
 */
export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  const detected = serverConfig?.environment.platform.machine ?? null;
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentMachineIcon kind={resolved} />
        Icon
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-44">
        {lock !== null ? (
          <>
            <MenuItem disabled className="whitespace-normal text-xs">
              {lock}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={resolved}
          onValueChange={(next) => {
            if (lock !== null) return;
            updateSettings({ environmentIcon: next === detected ? null : next });
          }}
        >
          {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
            <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
                </span>
                {kind === detected ? (
                  <span className="shrink-0 text-xs text-muted-foreground">detected</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
