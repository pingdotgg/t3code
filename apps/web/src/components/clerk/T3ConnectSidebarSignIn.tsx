import { UserButton, useAuth, useUser } from "@clerk/react";
import { T, useGT, useMessages } from "gt-react";
import { LogInIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { retryClerkLoad, useClerkLoadFailed } from "./clerkLoadFailure";
import { T3_CONNECT_ACCOUNT_PAGES } from "./T3ConnectAccountPages";
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
  const { isLoaded, isSignedIn, user } = useUser();
  const [open, setOpen] = useState(false);
  const gt = useGT();
  const m = useMessages();

  if (!isLoaded || !isSignedIn) return null;

  // Clerk pins UserButton's own popover to bottom-end, which hangs off the settings modal from this
  // bottom-left avatar. The provider keeps the account pages mounted; the outlet is just the menu.
  return (
    <UserButton
      __experimental_asProvider
      appearance={{
        elements: {
          userButtonPopoverCard: "m-0 w-80 max-w-full border-0 bg-transparent shadow-none",
        },
      }}
    >
      {T3_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={m(page.label)}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={gt("Account menu")}
          render={
            <button
              className="mb-1 self-start rounded-lg p-1 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-sidebar-row-hover"
              type="button"
            />
          }
        >
          <img alt="" className="size-7 rounded-full" src={user.imageUrl} />
        </PopoverTrigger>
        <PopoverPopup align="start" padding="none" side="top" sideOffset={8}>
          <UserButton.__experimental_Outlet __experimental_asStandalone={setOpen} />
        </PopoverPopup>
      </Popover>
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (loadFailed) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={retryClerkLoad}>
            <RotateCwIcon />
            <span>
              <T>Retry T3 Connect</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>
            <T>Sign in to T3 Connect</T>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
