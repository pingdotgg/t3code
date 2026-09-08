import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { getHostStoragePresentation } from "@t3tools/client-runtime/host-storage";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function ConnectedStorageReading({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const query = serverEnvironment.hostResources({ environmentId, input: {} });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const storage = getHostStoragePresentation(result);

  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1.5" aria-live="polite">
        <p className="text-xs tabular-nums">
          {storage.status === "available"
            ? storage.label
            : storage.status === "loading"
              ? "Reading storage…"
              : "Storage unavailable"}
        </p>
        {storage.status === "available" ? (
          <>
            <div
              role="meter"
              aria-label={`${label} available disk space`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={storage.availablePercent}
              aria-valuetext={storage.label}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${storage.availablePercent}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Checked{" "}
              <time dateTime={new Date(storage.sampledAt).toISOString()}>
                {new Date(storage.sampledAt).toLocaleTimeString()}
              </time>
            </p>
          </>
        ) : null}
      </div>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Refresh ${label} storage`}
        disabled={storage.status === "loading"}
        onClick={refresh}
      >
        <RefreshIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export function StorageSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return (
    <SettingsSection {...searchableSetting("disk-storage")}>
      {environments.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Connect an environment to check its disk space.
        </p>
      ) : (
        environments.map((environment) => (
          <div
            key={environment.environmentId}
            className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] sm:gap-8 sm:px-4"
          >
            <div className="min-w-0 space-y-1">
              <h3 className="flex items-start gap-1.5 text-sm font-medium">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 wrap-anywhere">{environment.label}</span>
              </h3>
              <p className="text-xs text-muted-foreground">
                {connectionStatusText(environment.connection)}
              </p>
            </div>
            {environment.connection.phase === "connected" ? (
              <ConnectedStorageReading
                environmentId={environment.environmentId}
                label={environment.label}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Storage unavailable</p>
            )}
          </div>
        ))
      )}
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground sm:px-4">
        Disk containing each server's T3 data. Projects on other drives may have different space
        available.
      </p>
    </SettingsSection>
  );
}
