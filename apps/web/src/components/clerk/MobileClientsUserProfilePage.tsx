import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { SmartphoneIcon } from "lucide-react";

import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { useT } from "../../hooks/useI18n";
import {
  mobileClientNotificationDetail,
  mobileClientPlatformLabel,
  mobileClientUpdatedAtLabel,
} from "./MobileClientsUserProfilePage.logic";
import {
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";

const MOBILE_CLIENT_SKELETON_ROWS = ["primary", "secondary"] as const;

function MobileClientStatusBadge({
  enabled,
  label,
}: {
  readonly enabled: boolean;
  readonly label: string;
}) {
  const t = useT();
  return (
    <Badge variant={enabled ? "success" : "outline"}>
      {t("misc.clerk.mobile.statusBadge", {
        label,
        state: enabled ? t("misc.clerk.mobile.on") : t("misc.clerk.mobile.off"),
      })}
    </Badge>
  );
}

function MobileClientRow({ device }: { readonly device: RelayClientDeviceRecord }) {
  const t = useT();
  return (
    <ClerkUserProfileRow icon={<SmartphoneIcon className="size-4" />}>
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm leading-4.5 font-medium text-foreground">
            {device.label}
          </h3>
          <p className="text-xs leading-4.5 text-muted-foreground">
            {mobileClientPlatformLabel(device)}
          </p>
        </div>
        <p className="shrink-0 text-2xs leading-4 text-muted-foreground/75">
          {mobileClientUpdatedAtLabel(device.updatedAt, t)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <MobileClientStatusBadge
          enabled={device.notifications.enabled}
          label={t("misc.clerk.mobile.pushNotifications")}
        />
        <MobileClientStatusBadge
          enabled={device.liveActivities.enabled}
          label={t("misc.clerk.mobile.liveActivities")}
        />
      </div>
      <p className="mt-1.5 text-xs leading-4.5 text-muted-foreground/80">
        {mobileClientNotificationDetail(device, t)}
      </p>
    </ClerkUserProfileRow>
  );
}

function MobileClientsSkeleton() {
  const t = useT();
  return (
    <div aria-label={t("misc.clerk.mobile.loading")} className="divide-y border-t" role="status">
      {MOBILE_CLIENT_SKELETON_ROWS.map((row) => (
        <div key={row} className="py-4">
          <div className="flex gap-3">
            <Skeleton shape="card" className="size-8 shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3 w-28" />
              <div className="flex gap-2">
                <Skeleton className="h-4.5 w-28" />
                <Skeleton className="h-4.5 w-24" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyMobileClients() {
  const t = useT();
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{t("misc.clerk.mobile.empty.title")}</EmptyTitle>
        <EmptyDescription>{t("misc.clerk.mobile.empty.description")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function MobileClientsUserProfilePage() {
  const t = useT();
  const devicesState = useManagedRelayDevices();
  const devices = devicesState.data ?? [];
  const isInitialLoad =
    !devicesState.accountId || (devicesState.data === null && !devicesState.error);
  const hasErrorWithoutData = devicesState.error !== null && devicesState.data === null;

  return (
    <ClerkUserProfilePage
      title={t("misc.clerk.mobile.title")}
      description={t("misc.clerk.mobile.description")}
      action={
        <ClerkUserProfileRefreshButton
          isPending={devicesState.isPending}
          onClick={devicesState.refresh}
        />
      }
    >
      <div>
        {devicesState.error ? (
          <div
            className="mb-4 flex flex-col gap-3 border-t border-destructive/35 py-3 text-xs sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <div>
              <p className="font-medium text-destructive-foreground">
                {t("misc.clerk.mobile.loadFailed")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{devicesState.error}</p>
            </div>
            <Button size="xs" variant="outline" onClick={devicesState.refresh}>
              {t("misc.common.tryAgain")}
            </Button>
          </div>
        ) : null}

        {isInitialLoad ? (
          <MobileClientsSkeleton />
        ) : hasErrorWithoutData ? null : devices.length > 0 ? (
          <ul className="border-t">
            {devices.map((device) => (
              <MobileClientRow key={device.deviceId} device={device} />
            ))}
          </ul>
        ) : (
          <div className="border-t">
            <EmptyMobileClients />
          </div>
        )}
      </div>
    </ClerkUserProfilePage>
  );
}
