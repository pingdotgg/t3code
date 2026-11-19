import { msg, T, useGT, useMessages } from "gt-react";
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
  const gt = useGT();
  const m = useMessages();
  const label = kind === "hub" ? msg("Device hub") : msg("Agent device");
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          kind
            ? version
              ? gt("{tool}: version {version}. Show details", { tool: m(label), version })
              : selected
                ? gt("{tool}: not installed. Show details", { tool: m(label) })
                : gt("{tool}: version unknown. Show details", { tool: m(label) })
            : undefined
        }
        render={<InlineButton tone="muted" />}
      >
        {kind
          ? version
            ? `v${version}`
            : selected
              ? gt("Not installed")
              : gt("Version unknown")
          : error
            ? gt("Versions unavailable")
            : gt("Versions")}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle>{kind ? m(label) : gt("Device tools")}</PopoverTitle>
        {tools ? (
          <div className="mt-4 divide-y divide-border">
            {(
              [
                [msg("Device hub"), tools.hub],
                [msg("Agent device"), tools.agent],
              ] as const
            )
              .filter(([name]) => !kind || name === label)
              .map(([name, tool]) => (
                <div key={name} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  {!kind ? <p className="text-xs font-medium">{m(name)}</p> : null}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-dim-foreground">
                      <T context="running tool version">Running</T>
                    </dt>
                    <dd className="text-right font-mono">
                      {tool.runningVersion ?? gt("Not running")}
                    </dd>
                    <dt className="text-dim-foreground">
                      <T context="required tool version">Required</T>
                    </dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-dim-foreground">
                      <T context="installed tool versions">Installed</T>
                    </dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || gt("None", { $context: "no versions" })}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            <T>Versions have not been checked.</T>
          </p>
        )}
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          {owner ? `${gt("Managed by {owner}.", { owner })} ` : ""}
          {gt("Tools update automatically on this host when needed.")}
        </p>
        {error ? (
          <p role="status" className="mt-2 text-xs text-error-foreground">
            {error}
          </p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}
