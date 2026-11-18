import {
  AuthSettingsWriteScope,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";
import { Fragment } from "react";
import { msg, T, useGT, useMessages } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

export function resolveEnvironmentIconPickerLock(
  input: {
    readonly serverConfig: Pick<ServerConfig, "environment"> | null;
    readonly operateAccess: "granted" | "denied" | "pending";
  },
  resolve: MessageResolver = m,
): string | null {
  if (input.serverConfig === null) {
    return resolve(msg("Connect to this environment to change its icon."));
  }
  if (input.operateAccess !== "granted") {
    return resolve(msg("Your session on this environment cannot change its settings."));
  }
  return null;
}

export const ENVIRONMENT_ICON_GROUPS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly kinds: ReadonlyArray<EnvironmentMachineKind>;
}> = [
  {
    key: "machines",
    label: msg("Machines", { $context: "group of machine icons" }),
    kinds: [
      "server",
      "cloud",
      "desktop",
      "laptop",
      "mac-mini",
      "mac-studio",
      "raspberry-pi",
      "docker",
    ],
  },
  {
    key: "systems",
    label: msg("Systems", { $context: "group of operating system icons" }),
    kinds: ["macos", "windows", "linux", "wsl"],
  },
  {
    key: "linux-distributions",
    label: msg("Linux distributions"),
    kinds: ["debian", "ubuntu", "fedora", "arch", "mint", "opensuse", "nixos", "alpine"],
  },
];

// What servers that predate `environmentIconKinds` accept.
const LEGACY_ENVIRONMENT_ICON_KINDS: ReadonlyArray<EnvironmentMachineKind> = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
];

// Limited to kinds the server can store, so an older server never receives one it rejects.
export function resolveEnvironmentIconGroups(
  serverConfig: Pick<ServerConfig, "environment"> | null,
) {
  const accepted: ReadonlyArray<string> =
    serverConfig?.environment.capabilities.environmentIconKinds ?? LEGACY_ENVIRONMENT_ICON_KINDS;
  return ENVIRONMENT_ICON_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    kinds: group.kinds.filter((kind) => accepted.includes(kind)),
  })).filter((group) => group.kinds.length > 0);
}

export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ? "granted"
    : "denied";
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess }, resolve);
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentMachineIcon kind={resolved} />
        <T>Icon</T>
      </MenuSubTrigger>
      <MenuSubPopup>
        {lock !== null ? (
          <>
            <MenuItem disabled className="whitespace-normal">
              {lock}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={resolved}
          onValueChange={(next) => {
            if (lock !== null || !isEnvironmentMachineKind(next)) return;
            updateSettings({ environmentIcon: next === detected ? null : next });
          }}
        >
          {resolveEnvironmentIconGroups(serverConfig).map((group, index) => (
            <Fragment key={group.key}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <MenuGroupLabel>{resolve(group.label)}</MenuGroupLabel>
                {group.kinds.map((kind) => (
                  <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
                    <span className="flex min-w-0 items-center gap-2">
                      <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {resolve(ENVIRONMENT_MACHINE_KIND_LABELS[kind])}
                      </span>
                      {kind === detected ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {serverConfig?.environment.platform.machine
                            ? gt("detected", { $context: "machine kind detected automatically" })
                            : gt("default", {
                                $context: "machine kind used when none is detected",
                              })}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            </Fragment>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
