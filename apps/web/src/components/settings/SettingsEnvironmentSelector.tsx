import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, TerminalIcon } from "lucide-react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function environmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function environmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

export function SettingsEnvironmentSelector({
  environments,
  isReady,
  selectedEnvironmentId,
  emptyDescription,
  onSelect,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly isReady: boolean;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly emptyDescription: string;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  const onlyPrimaryDevice =
    environments.length === 1 && environments[0]?.entry.target._tag === "PrimaryConnectionTarget";
  if (onlyPrimaryDevice) return null;

  return (
    <SettingsSection title="Devices">
      {environments.length === 0 ? (
        <SettingsRow
          title={isReady ? "No connected devices" : "Loading devices"}
          description={isReady ? emptyDescription : "Reading connected execution environments."}
        />
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {environments.map((environment) => {
            const Icon = environmentIcon(environment);
            const selected = environment.environmentId === selectedEnvironmentId;
            const statusText = connectionStatusText(environment.connection);
            return (
              <button
                key={environment.environmentId}
                type="button"
                aria-pressed={selected}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors sm:px-4",
                  selected
                    ? "bg-primary/8 ring-1 ring-primary/25 dark:bg-primary/12"
                    : "hover:bg-muted/40",
                )}
                onClick={() => onSelect(environment.environmentId)}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <ConnectionStatusDot
                      tooltipText={statusText}
                      dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                      pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                    />
                    <span className="truncate text-sm font-medium text-foreground">
                      {environment.label}
                    </span>
                  </span>
                  <span className="block truncate pl-[18px] text-xs text-muted-foreground">
                    {environmentDetail(environment)} · {statusText}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
