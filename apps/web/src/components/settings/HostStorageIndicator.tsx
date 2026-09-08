import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getHostStoragePresentation } from "@t3tools/client-runtime/host-storage";

import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";

function StorageRing({
  label,
  storage,
  onRefresh,
}: {
  label: string;
  storage: ReturnType<typeof getHostStoragePresentation>;
  onRefresh?: () => void;
}) {
  const reading =
    storage.status === "available"
      ? storage.label
      : storage.status === "loading"
        ? "Reading storage…"
        : "Storage unavailable";
  const usedPercent = storage.status === "available" ? 100 - storage.availablePercent : null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 shrink-0 rounded-full"
            aria-label={`${label} disk space: ${reading}`}
          >
            <svg viewBox="0 0 24 24" className="size-5! -rotate-90" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.2"
                strokeWidth="3"
              />
              {usedPercent !== null ? (
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  pathLength="100"
                  strokeDasharray={`${usedPercent} 100`}
                  className={usedPercent >= 90 ? "text-warning" : "text-muted-foreground"}
                />
              ) : null}
            </svg>
          </Button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-64"
        viewportClassName="py-3 [--viewport-inline-padding:--spacing(3)]"
      >
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Disk space</span>
            {onRefresh ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Refresh ${label} storage`}
                disabled={storage.status === "loading"}
                onClick={onRefresh}
              >
                <RefreshIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <p className="tabular-nums" aria-live="polite">
            {reading}
          </p>
          {storage.status === "available" ? (
            <p className="text-muted-foreground">
              {Math.round(100 - storage.availablePercent)}% used or reserved
              <br />
              Checked {new Date(storage.sampledAt).toLocaleTimeString()}
            </p>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Disk containing this server's T3 data. Other drives may have different space available.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ConnectedStorageIndicator({ environment }: { environment: EnvironmentPresentation }) {
  const query = serverEnvironment.hostResources({
    environmentId: environment.environmentId,
    input: {},
  });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  return (
    <StorageRing
      label={environment.label}
      storage={getHostStoragePresentation(result)}
      onRefresh={refresh}
    />
  );
}

export function HostStorageIndicator({ environment }: { environment: EnvironmentPresentation }) {
  return environment.connection.phase === "connected" ? (
    <ConnectedStorageIndicator environment={environment} />
  ) : (
    <StorageRing label={environment.label} storage={{ status: "unavailable" }} />
  );
}
