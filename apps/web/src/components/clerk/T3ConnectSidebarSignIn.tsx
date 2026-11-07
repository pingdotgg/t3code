import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, LogOutIcon } from "lucide-react";

import { useCloudAuth } from "../../cloud/cloudAuth";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { T3_CONNECT_ACCOUNT_PAGES } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  const { provider, isLoaded, isSignedIn } = useCloudAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (provider === null || !isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>Sign in to T3 Connect</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function T3ConnectSidebarAvatar() {
  const { provider } = useCloudAuth();

  if (provider === "clerk") return <ClerkSidebarAvatar />;
  if (provider === "oidc") return <OidcSidebarAccount />;
  return null;
}

function ClerkSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
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
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

/** An OpenID Connect provider hosts no account pages, so the account is just a way to sign out. */
function OidcSidebarAccount() {
  const { isSignedIn, accountLabel, signOut } = useCloudAuth();

  if (!isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => void signOut()} title="Sign out of T3 Connect">
          <LogOutIcon />
          <span className="truncate">Sign out{accountLabel ? ` (${accountLabel})` : ""}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
