import { UserButton, Waitlist, useAuth } from "@clerk/react";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { CloudIcon, RefreshCwIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { updatePrimaryCloudPreferences } from "../../cloud/linkEnvironment";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useManagedRelayDevices } from "../../cloud/managedRelayState";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { webRuntime } from "../../lib/runtime";
import { cn } from "../../lib/utils";
import { DesktopClerkWaitlist } from "../clerk/DesktopClerkWaitlist";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const NOTIFICATION_DEVICE_SKELETON_ROWS = ["primary", "secondary"] as const;

function NotificationDevicesSkeleton() {
  return NOTIFICATION_DEVICE_SKELETON_ROWS.map((row) => (
    <div key={row} className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32 rounded-full" />
        <Skeleton className="h-3 w-44 rounded-full" />
        <Skeleton className="h-3 w-56 rounded-full" />
      </div>
    </div>
  ));
}

function EmptyNotificationDevices() {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <SmartphoneIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No notification devices</EmptyTitle>
        <EmptyDescription>
          Sign in on the mobile app to register a device for account-level notifications.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function cloudErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function CloudSettingsPanel() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredCloudSettingsPanel />;
}

function ConfiguredCloudSettingsPanel() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return null;
  }

  return isSignedIn ? <CloudSettingsPanelInner /> : <CloudWaitlistPanel />;
}

function CloudWaitlistPanel() {
  return (
    <SettingsPageContainer className="min-h-full items-center justify-center">
      {isElectron ? <DesktopClerkWaitlist /> : <Waitlist />}
    </SettingsPageContainer>
  );
}

function CloudSettingsPanelInner() {
  const primaryLinkState = usePrimaryCloudLinkState();
  const primarySessionState = usePrimarySessionState();
  const devicesState = useManagedRelayDevices();
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);
  const devices = devicesState.data ?? [];
  const canManageRelay =
    primarySessionState.data?.authenticated === true &&
    Boolean(primarySessionState.data.scopes?.includes(AuthRelayWriteScope));

  useEffect(() => {
    if (devicesState.error) {
      toastManager.add({
        type: "error",
        title: "Cloud devices unavailable",
        description: devicesState.error,
      });
    }
  }, [devicesState.error]);

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    try {
      await webRuntime.runPromise(updatePrimaryCloudPreferences({ publishAgentActivity: enabled }));
      primaryLinkState.refresh();
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment can publish agent activity to your notification devices."
          : "This environment will stop publishing agent activity.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud preference update failed",
        description: cloudErrorMessage(error, "Could not update cloud preferences."),
      });
    } finally {
      setIsUpdatingPreference(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow
          title="Cloud account"
          description="Manage your private-beta T3 Cloud session."
          control={<UserButton />}
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Publish agent activity"
          description="Allow this environment to send agent activity to your notification devices."
          status={
            !primaryLinkState.data?.linked ? "Link this environment from Connections first." : null
          }
          control={
            <Switch
              aria-label="Publish agent activity"
              checked={primaryLinkState.data?.publishAgentActivity ?? false}
              disabled={!primaryLinkState.data?.linked || !canManageRelay || isUpdatingPreference}
              onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Notification devices"
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={devicesState.isPending}
                  onClick={devicesState.refresh}
                  aria-label="Refresh notification devices"
                >
                  <RefreshCwIcon
                    className={cn("size-3", devicesState.isPending && "animate-spin")}
                  />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh notification devices</TooltipPopup>
          </Tooltip>
        }
      >
        {devicesState.data === null ? (
          <NotificationDevicesSkeleton />
        ) : devices.length > 0 ? (
          devices.map((device) => (
            <SettingsRow
              key={device.deviceId}
              title={device.label}
              description={`iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`}
              status={
                device.notifications.enabled
                  ? device.liveActivities.enabled
                    ? "Notifications and Live Activities enabled"
                    : "Notifications enabled · Live Activities disabled"
                  : "Notifications disabled on device"
              }
            />
          ))
        ) : (
          <EmptyNotificationDevices />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
