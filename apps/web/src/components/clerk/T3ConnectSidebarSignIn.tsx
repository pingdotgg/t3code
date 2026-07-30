import { UserButton, useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, LogInIcon, SmartphoneIcon } from "lucide-react";
import { useCallback } from "react";

import { hasCloudPublicConfig, resolveCloudPublicConfigState } from "../../cloud/publicConfig";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { cn } from "../../lib/utils";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import {
  resolveT3ConnectSidebarPresentation,
  type T3ConnectSidebarStatusTone,
} from "./T3ConnectSidebarControl.logic";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

const STATUS_DOT_CLASSNAME: Record<T3ConnectSidebarStatusTone, string> = {
  error: "bg-destructive",
  muted: "bg-muted-foreground/45",
  pending: "bg-amber-500",
  success: "bg-emerald-500",
};

export function T3ConnectSidebarControl() {
  const configState = resolveCloudPublicConfigState();
  if (!configState.configured) {
    const diagnostic = import.meta.env.DEV
      ? `Missing ${configState.missingKeys.join(", ")}`
      : "See build diagnostics";
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-disabled="true"
            className="h-10 gap-2 px-2 py-1.5 opacity-60"
            data-testid="t3-connect-unavailable"
            disabled
            title={diagnostic}
            tooltip={diagnostic}
          >
            <CloudIcon className="size-3.5" />
            <span className="min-w-0">
              <span className="block truncate text-xs">T3 Connect unavailable</span>
              <span className="block truncate text-[10px] font-normal text-muted-foreground">
                {diagnostic}
              </span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return <ConfiguredT3ConnectSidebarControl />;
}

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarControl() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded) {
    return <T3ConnectSidebarStatusRow label="Connecting…" onClick={undefined} tone="pending" />;
  }

  if (!isSignedIn) {
    return (
      <>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-9 gap-2 px-2 py-1.5 active:scale-[0.98]"
              data-testid="t3-connect-sign-in"
              onClick={openAuthPrompt}
              tooltip="Sign in to T3 Connect"
            >
              <CloudIcon className="size-3.5" />
              <span className="truncate text-xs">Sign in to T3 Connect</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {authPrompt}
      </>
    );
  }

  return <ConfiguredT3ConnectSidebarStatus />;
}

function ConfiguredT3ConnectSidebarStatus() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { linkState, managedTunnelActive, publishAgentActivity, operationError } =
    useCloudLinkController();
  const error = operationError ?? linkState.error;
  const presentation = resolveT3ConnectSidebarPresentation({
    error,
    isPending: linkState.isPending,
    managedTunnelActive,
    publishAgentActivity,
  });
  const handleClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings/connections" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="t3-connect-status">
      <T3ConnectSidebarStatusRow
        error={error}
        label={presentation.label}
        onClick={handleClick}
        tone={presentation.tone}
      />
      <ConfiguredT3ConnectSidebarAvatar />
    </div>
  );
}

function T3ConnectSidebarStatusRow({
  error,
  label,
  onClick,
  tone,
}: {
  readonly error?: string | null;
  readonly label: string;
  readonly onClick: (() => void) | undefined;
  readonly tone: T3ConnectSidebarStatusTone;
}) {
  return (
    <SidebarMenu className="min-w-0 flex-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-10 min-w-0 gap-2 px-2 py-1.5 active:scale-[0.98]"
          disabled={!onClick}
          onClick={onClick}
          title={error ?? undefined}
          tooltip="Open T3 Connect settings"
        >
          <CloudIcon className="size-3.5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs">T3 Connect</span>
            <span className="flex items-center gap-1.5 truncate text-[10px] font-normal text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASSNAME[tone])}
              />
              <span className="truncate">{label}</span>
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to T3 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
