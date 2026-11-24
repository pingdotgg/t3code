import { UNSAFE_PortalProvider, UserButton, useAuth } from "@clerk/react";
import { T, useMessages } from "gt-react";
import { LogInIcon, RotateCwIcon } from "lucide-react";
import { useRef } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
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
  const { isLoaded, isSignedIn } = useAuth();
  const m = useMessages();
  const rootRef = useRef<HTMLDivElement>(null);

  if (!isLoaded || !isSignedIn) return null;

  // Clerk flips its menu only against the viewport; portaling it into the
  // Settings modal (which clips) makes it flip up when the modal has no room below.
  return (
    <div ref={rootRef} className="contents">
      <UNSAFE_PortalProvider
        getContainer={() => rootRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null}
      >
        <UserButton
          appearance={{
            elements: {
              avatarBox: "size-7",
              // Clerk's unlayered trigger reset (padding, radius, background) beats layered utilities.
              userButtonTrigger: "mb-1! rounded-lg! p-1! hover:bg-sidebar-row-hover!",
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
        </UserButton>
      </UNSAFE_PortalProvider>
    </div>
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
