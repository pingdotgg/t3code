import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { RefreshCwIcon, SmartphoneIcon } from "lucide-react";

import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  mobileClientNotificationDetail,
  mobileClientPlatformLabel,
  mobileClientUpdatedAtLabel,
} from "./MobileClientsUserProfilePage.logic";

const MOBILE_CLIENT_SKELETON_ROWS = ["primary", "secondary"] as const;

function MobileClientStatusBadge({
  enabled,
  label,
}: {
  readonly enabled: boolean;
  readonly label: string;
}) {
  return (
    <Badge variant={enabled ? "success" : "outline"}>
      {label}: {enabled ? "On" : "Off"}
    </Badge>
  );
}

function MobileClientRow({ device }: { readonly device: RelayClientDeviceRecord }) {
  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm/4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
          <SmartphoneIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">{device.label}</h3>
              <p className="text-xs text-muted-foreground">{mobileClientPlatformLabel(device)}</p>
            </div>
            <p className="shrink-0 text-[11px] text-muted-foreground/75">
              {mobileClientUpdatedAtLabel(device.updatedAt)}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <MobileClientStatusBadge
              enabled={device.notifications.enabled}
              label="Push notifications"
            />
            <MobileClientStatusBadge
              enabled={device.liveActivities.enabled}
              label="Live Activities"
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
            {mobileClientNotificationDetail(device)}
          </p>
        </div>
      </div>
    </li>
  );
}

function MobileClientsSkeleton() {
  return (
    <div aria-label="Loading mobile clients" className="space-y-3" role="status">
      {MOBILE_CLIENT_SKELETON_ROWS.map((row) => (
        <div key={row} className="rounded-xl border p-4">
          <div className="flex gap-3">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-28" />
              <div className="flex gap-2 pt-1">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-5 w-24" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyMobileClients() {
  return (
    <Empty className="min-h-72 rounded-xl border border-dashed bg-muted/15">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No mobile clients</EmptyTitle>
        <EmptyDescription>
          Sign in to T3 Code on your iPhone to register it for push notifications and Live
          Activities.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function MobileClientsUserProfilePage() {
  const devicesState = useManagedRelayDevices();
  const devices = devicesState.data ?? [];
  const isInitialLoad =
    !devicesState.accountId || (devicesState.data === null && !devicesState.error);
  const hasErrorWithoutData = devicesState.error !== null && devicesState.data === null;

  return (
    <div className="flex min-h-[30rem] w-full flex-col bg-background text-foreground">
      <header className="flex flex-col gap-4 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em]">Mobile clients</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Devices registered to receive T3 Connect activity from your environments.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={devicesState.isPending}
          onClick={devicesState.refresh}
        >
          <RefreshCwIcon className={cn("size-3.5", devicesState.isPending && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <div className="flex-1 p-6">
        {devicesState.error ? (
          <div
            className="mb-4 flex flex-col gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <div>
              <p className="font-medium text-destructive-foreground">
                Could not load mobile clients
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{devicesState.error}</p>
            </div>
            <Button size="xs" variant="outline" onClick={devicesState.refresh}>
              Try again
            </Button>
          </div>
        ) : null}

        {isInitialLoad ? (
          <MobileClientsSkeleton />
        ) : hasErrorWithoutData ? null : devices.length > 0 ? (
          <ul className="space-y-3">
            {devices.map((device) => (
              <MobileClientRow key={device.deviceId} device={device} />
            ))}
          </ul>
        ) : (
          <EmptyMobileClients />
        )}
      </div>
    </div>
  );
}
