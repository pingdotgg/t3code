import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { SmartphoneIcon } from "lucide-react";

import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { useI18n } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
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
  const { t } = useI18n();
  return (
    <Badge variant={enabled ? "success" : "outline"}>
      {label}: {enabled ? t("auth.on") : t("auth.off")}
    </Badge>
  );
}

function MobileClientRow({ device }: { readonly device: RelayClientDeviceRecord }) {
  const { t } = useI18n();
  return (
    <ClerkUserProfileRow icon={<SmartphoneIcon className="size-4" />}>
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[0.8125rem] leading-[1.125rem] font-medium text-foreground">
            {device.label}
          </h3>
          <p className="text-xs leading-[1.125rem] text-muted-foreground">
            {mobileClientPlatformLabel(device)}
          </p>
        </div>
        <p className="shrink-0 text-[0.6875rem] leading-4 text-muted-foreground/75">
          {mobileClientUpdatedAtLabel(device.updatedAt, t)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <MobileClientStatusBadge
          enabled={device.notifications.enabled}
          label={t("auth.pushNotifications")}
        />
        <MobileClientStatusBadge
          enabled={device.liveActivities.enabled}
          label={t("auth.liveActivities")}
        />
      </div>
      <p className="mt-1.5 text-xs leading-[1.125rem] text-muted-foreground/80">
        {mobileClientNotificationDetail(device, t)}
      </p>
    </ClerkUserProfileRow>
  );
}

function MobileClientsSkeleton() {
  const { t } = useI18n();
  return (
    <div aria-label={t("auth.mobileClientsLoading")} className="divide-y border-t" role="status">
      {MOBILE_CLIENT_SKELETON_ROWS.map((row) => (
        <div key={row} className="py-4">
          <div className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
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
  const { t } = useI18n();
  return (
    <Empty className="min-h-64 gap-4 border-t px-6 py-10 md:p-10">
      <EmptyMedia className="mb-0" variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-[1.0625rem] leading-6">{t("auth.noMobileClients")}</EmptyTitle>
        <EmptyDescription className="text-[0.8125rem] leading-[1.125rem]">
          {t("auth.noMobileClientsDescription")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function MobileClientsUserProfilePage() {
  const { t } = useI18n();
  const devicesState = useManagedRelayDevices();
  const devices = devicesState.data ?? [];
  const isInitialLoad =
    !devicesState.accountId || (devicesState.data === null && !devicesState.error);
  const hasErrorWithoutData = devicesState.error !== null && devicesState.data === null;

  return (
    <ClerkUserProfilePage
      title={t("auth.mobileClients")}
      description={t("auth.mobileClientsDescription")}
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
            className="mb-4 flex flex-col gap-3 border-t border-destructive/35 py-3 text-[0.8125rem] sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <div>
              <p className="font-medium text-destructive-foreground">
                {t("auth.mobileClientsLoadFailed")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{devicesState.error}</p>
            </div>
            <Button size="xs" variant="outline" onClick={devicesState.refresh}>
              {t("rootError.tryAgain")}
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
          <EmptyMobileClients />
        )}
      </div>
    </ClerkUserProfilePage>
  );
}
