import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
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
  const label = kind === "hub" ? t({ message: "Device hub" }) : t({ message: "Agent device" });
  const ownerText = owner ? `Managed by ${owner}. ` : "";
  const versionText = kind
    ? version
      ? `version ${version}`
      : selected
        ? "not installed"
        : "version unknown"
    : undefined;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={kind ? t`${label}: ${versionText}. Show details` : undefined}
        render={<InlineButton tone="muted" />}
      >
        {kind ? (
          version ? (
            <Trans>v{version}</Trans>
          ) : selected ? (
            <Trans>Not installed</Trans>
          ) : (
            <Trans>Version unknown</Trans>
          )
        ) : error ? (
          <Trans>Versions unavailable</Trans>
        ) : (
          <Trans>Versions</Trans>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle>{kind ? label : <Trans>Device tools</Trans>}</PopoverTitle>
        {tools ? (
          <div className="mt-4 divide-y divide-border/50">
            {(
              [
                ["Device hub", tools.hub],
                ["Agent device", tools.agent],
              ] as const
            )
              .filter(([name]) => !kind || name === label)
              .map(([name, tool]) => (
                <div key={name} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  {!kind ? <p className="text-xs font-medium">{name}</p> : null}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">
                      <Trans>Running</Trans>
                    </dt>
                    <dd className="text-right font-mono">
                      {tool.runningVersion ?? <Trans>Not running</Trans>}
                    </dd>
                    <dt className="text-muted-foreground">
                      <Trans>Required</Trans>
                    </dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-muted-foreground">
                      <Trans>Installed</Trans>
                    </dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || <Trans>None</Trans>}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            <Trans>Versions have not been checked.</Trans>
          </p>
        )}
        <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          <Trans>{ownerText}Tools update automatically on this host when needed.</Trans>
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
