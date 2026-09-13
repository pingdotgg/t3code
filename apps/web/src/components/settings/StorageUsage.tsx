import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const CATEGORIES = [
  { key: "worktrees", label: "Worktrees", color: "bg-blue-400" },
  { key: "browserArtifacts", label: "Browser captures", color: "bg-violet-400" },
  { key: "logs", label: "Logs", color: "bg-sky-400" },
  { key: "attachments", label: "Attachments", color: "bg-amber-400" },
  { key: "other", label: "Other T3 files", color: "bg-muted-foreground/50" },
] as const;

function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index =
    bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

function MachineStorageUsage({ environment }: { environment: EnvironmentPresentation }) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const supported = environment.serverConfig?.environment.capabilities.storageUsage === true;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    connected && supported
      ? serverEnvironment.storageUsage({
          environmentId: environment.environmentId,
          input: { refresh: true },
        })
      : null,
  );
  return (
    <div className="space-y-1 px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="max-w-1/2 shrink-0 truncate text-sm font-medium">{environment.label}</div>
          {environment.displayUrl ? (
            <div className="truncate text-xs text-muted-foreground">{environment.displayUrl}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {data ? (
            <div className="text-xs text-muted-foreground">
              <span className="tabular-nums">
                {data.partial ? "≥ " : ""}
                {formatBytes(data.totalBytes)} T3 files
              </span>
            </div>
          ) : null}
          {connected && supported ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Refresh storage usage for ${environment.label}`}
              onClick={refresh}
              disabled={isPending}
            >
              <RefreshIcon refreshing={isPending} />
            </Button>
          ) : null}
        </div>
      </div>
      {!connected ? (
        <p className="text-xs text-muted-foreground">Offline</p>
      ) : !supported ? (
        <p className="text-xs text-muted-foreground">Update this server to see storage usage.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't measure storage usage. Try refreshing.
        </p>
      ) : null}
      {connected && supported && data === null && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          Measuring storage usage...
        </p>
      ) : null}
      {data ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={150}
            render={
              <button
                type="button"
                aria-label={`Storage breakdown for ${environment.label}`}
                className="flex h-6 w-full items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <span
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
              aria-hidden="true"
            >
              {CATEGORIES.map(({ key, color }) => (
                <span
                  key={key}
                  className={color}
                  style={{
                    width: `${data.totalBytes > 0 ? (data.categories[key].bytes / data.totalBytes) * 100 : 0}%`,
                  }}
                />
              ))}
            </span>
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
            <dl className="space-y-2 text-xs">
              {CATEGORIES.map(({ key, label, color }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
                    {label}
                  </dt>
                  <dd className="tabular-nums text-muted-foreground">
                    {data.categories[key].partial ? "≥ " : ""}
                    {formatBytes(data.categories[key].bytes)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 space-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground">
              <p>
                {data.disk
                  ? `${formatBytes(data.disk.availableBytes)} free of ${formatBytes(data.disk.totalBytes)}`
                  : "Disk capacity unavailable"}
              </p>
              <p>
                Measured{" "}
                {new Date(data.sampledAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <p>Linked files aren't followed.</p>
              {data.partial ? (
                <p className="text-warning">Incomplete scan. Sizes are lower bounds.</p>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

export function StorageUsageSection() {
  const { environments } = useSettingsScope();
  return (
    <SettingsSection id="storage-usage" title="Disk usage">
      {environments.map((environment) => (
        <MachineStorageUsage key={environment.environmentId} environment={environment} />
      ))}
      {environments.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground sm:px-4">
          Connect an environment to see storage usage.
        </p>
      ) : null}
    </SettingsSection>
  );
}
