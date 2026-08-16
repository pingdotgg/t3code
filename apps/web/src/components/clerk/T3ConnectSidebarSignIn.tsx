import { UserButton, useAuth, useUser } from "@clerk/react";
import { LogInIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { useRef } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

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
  const { user } = useUser();
  const profileRefreshRef = useRef<Promise<unknown> | null>(null);

  const refreshAccountProfile = () => {
    if (!user || profileRefreshRef.current) return;

    const refresh = user
      .reload()
      .catch(() => undefined)
      .finally(() => {
        if (profileRefreshRef.current === refresh) profileRefreshRef.current = null;
      });
    profileRefreshRef.current = refresh;
  };

  if (!isLoaded || !isSignedIn) return null;

  return (
    <span
      className="inline-flex"
      onFocus={refreshAccountProfile}
      onPointerDown={refreshAccountProfile}
    >
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
        <UserButton.UserProfilePage
          label="T3 Connect"
          labelIcon={<ServerIcon className="size-4" />}
          url="t3-connect"
        >
          <T3ConnectUserProfilePage />
        </UserButton.UserProfilePage>
      </UserButton>
    </span>
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
