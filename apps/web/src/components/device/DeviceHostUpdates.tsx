import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";

const UPDATING_HOST_STATUSES = new Set(["installing", "starting", "failed"]);

/** Whether DeviceHostUpdates shows anything for this state. */
export function hasDeviceHostUpdates(state: DeviceServiceState): boolean {
  return (
    state.hostStatus !== "disabled" &&
    state.hosts.some((host) =>
      UPDATING_HOST_STATUSES.has(state.hostStatuses[host.id]?.status ?? ""),
    )
  );
}

export function DeviceHostUpdates({
  state,
  environmentId,
}: {
  state: DeviceServiceState;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const retry = useAtomCommand(deviceEnvironment.list);
  const [pending, setPending] = useState<string | null>(null);
  if (!hasDeviceHostUpdates(state)) return null;
  return (
    <div className="space-y-2">
      {state.hosts.map((host) => {
        const status = state.hostStatuses[host.id];
        if (!status || !UPDATING_HOST_STATUSES.has(status.status)) return null;
        const failed = status.status === "failed";
        return (
          <div
            key={host.id}
            role={failed ? "alert" : "status"}
            className="flex items-start gap-3 rounded-card surface-panel px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-strong-foreground">{host.label}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {status.detail ??
                  (failed
                    ? gt("Device support could not start.")
                    : status.status === "installing"
                      ? gt("Installing device tools…")
                      : gt("Starting device tools…"))}
              </p>
              {failed ? (
                <p className="mt-1 text-muted-foreground">
                  <T>
                    Check the host connection and network access, then retry. Your device settings
                    are saved.
                  </T>
                </p>
              ) : null}
            </div>
            {failed && state.supportsHostRetry ? (
              <Button
                size="compact"
                variant="secondary"
                disabled={pending !== null}
                onClick={() => {
                  setPending(host.id);
                  void retry({ environmentId, input: { retryHostId: host.id } }).finally(() =>
                    setPending(null),
                  );
                }}
              >
                {pending === host.id ? gt("Retrying…") : gt("Retry")}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
