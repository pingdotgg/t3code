import { translate } from "@t3tools/i18n";
import type { ReactNode } from "react";
import type { DeviceToolVersions as ToolVersions } from "@t3tools/contracts";
import { InlineButton } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

export function DeviceToolVersions({
  tools,
  action,
  kind,
  owner,
  error,
}: {
  tools: ToolVersions | undefined;
  action?: ReactNode;
  kind?: keyof ToolVersions;
  owner?: string | undefined;
  error?: string | undefined;
}) {
  const selected = kind ? tools?.[kind] : undefined;
  const version =
    selected?.runningVersion ??
    (selected?.installedVersions.includes(selected.requiredVersion)
      ? selected.requiredVersion
      : selected?.installedVersions
          .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1));
  const label = translate(
    kind === "hub" ? "common:uiDeviceHubLabel" : "common:uiAgentDeviceLabel",
    kind === "hub" ? "Device hub" : "Agent device",
  );
  const versionLabel = version
    ? translate("common:uiDeviceToolVersion", "version {{version}}", { version })
    : selected
      ? translate("common:uiDeviceToolNotInstalled", "not installed")
      : translate("common:uiDeviceToolVersionUnknown", "version unknown");
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          kind
            ? translate("common:uiDeviceToolShowDetails", "{{label}}: {{version}}. Show details", {
                label,
                version: versionLabel,
              })
            : undefined
        }
        render={<InlineButton tone="muted" />}
      >
        {kind
          ? version
            ? `v${version}`
            : selected
              ? translate("common:uiDeviceToolNotInstalled", "Not installed")
              : translate("common:uiDeviceToolVersionUnknown", "Version unknown")
          : error
            ? translate("common:uiVersionsUnavailable", "Versions unavailable")
            : translate("common:uiVersions", "Versions")}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle>
          {kind ? label : translate("common:uiDeviceTools", "Device tools")}
        </PopoverTitle>
        {tools ? (
          <div className="mt-4 divide-y divide-border/50">
            {(
              [
                [translate("common:uiDeviceHubLabel", "Device hub"), tools.hub],
                [translate("common:uiAgentDeviceLabel", "Agent device"), tools.agent],
              ] as const
            )
              .filter(([name]) => !kind || name === label)
              .map(([name, tool]) => (
                <div key={name} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  {!kind ? <p className="text-xs font-medium">{name}</p> : null}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">
                      {translate("chatView:versionRunning", "Running")}
                    </dt>
                    <dd className="text-right font-mono">
                      {tool.runningVersion ?? translate("common:uiDeviceNotRunning", "Not running")}
                    </dd>
                    <dt className="text-muted-foreground">
                      {translate("chatView:versionRequired", "Required")}
                    </dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-muted-foreground">
                      {translate("chatView:versionInstalled", "Installed")}
                    </dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || translate("common:uiNone", "None")}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {translate("chatView:versionsNotChecked", "Versions have not been checked.")}
          </p>
        )}
        <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          {owner
            ? `${translate("common:uiManagedByOwner", "Managed by {{owner}}.", { owner })} `
            : ""}
          {translate(
            "common:uiDeviceToolsUpdateAutomatically",
            "Tools update automatically on this host when needed.",
          )}
        </p>
        {error ? (
          <p role="status" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}
