import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
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

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-accent",
        },
      }}
    />
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
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={openAuthPrompt}
          >
            <LogInIcon className="size-4" />
            <span>Sign in to T3 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
