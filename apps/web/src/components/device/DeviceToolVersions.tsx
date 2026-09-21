import type { DeviceToolVersions as ToolVersions } from "@t3tools/contracts";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

export function DeviceToolVersions({
  tools,
  kind,
  error,
}: {
  tools: ToolVersions | undefined;
  kind?: keyof ToolVersions;
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
  const label = kind === "hub" ? "Device hub" : "Agent device";
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          kind
            ? `${label}: ${version ? `version ${version}` : selected ? "not installed" : "version unknown"}. Show details`
            : undefined
        }
        className="rounded text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {kind
          ? version
            ? `v${version}`
            : selected
              ? "Not installed"
              : "Version unknown"
          : "Versions"}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <PopoverTitle className="text-sm">{kind ? label : "Device tools"}</PopoverTitle>
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
                  <p className="text-xs font-medium">{name}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Running</dt>
                    <dd className="text-right font-mono">{tool.runningVersion ?? "Not running"}</dd>
                    <dt className="text-muted-foreground">Required</dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-muted-foreground">Installed</dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || "None"}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Versions have not been checked.</p>
        )}
        <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">Tools update automatically on this host when needed.</p>
        {error ? <p role="status" className="mt-2 text-xs text-destructive">{error}</p> : null}
      </PopoverPopup>
    </Popover>
  );
}
