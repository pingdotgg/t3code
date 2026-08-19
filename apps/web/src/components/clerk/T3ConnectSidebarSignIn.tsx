import { UserButton } from "@clerk/react";
import { LogInIcon, LogOutIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useT3ConnectAuth } from "../../cloud/connectAuth";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { isElectron } from "../../env";
import { Dialog, DialogPanel, DialogPopup } from "../ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
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

  return isElectron ? <DesktopConnectAvatar /> : <ClerkSidebarAvatar />;
}

function ClerkSidebarAvatar() {
  const { isLoaded, isSignedIn } = useT3ConnectAuth();

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
      <UserButton.UserProfilePage
        label="T3 Connect"
        labelIcon={<ServerIcon className="size-4" />}
        url="t3-connect"
      >
        <T3ConnectUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

type DesktopAccountPage = "t3-connect" | "mobile-clients";

/**
 * Desktop account control. The desktop app has no in-app auth UI — the
 * session lives in the local environment server — so this replaces Clerk's
 * UserButton with a plain menu over the same relay-backed pages.
 */
function DesktopConnectAvatar() {
  const { identity, isLoaded, isSignedIn, signOut } = useT3ConnectAuth();
  const [openPage, setOpenPage] = useState<DesktopAccountPage | null>(null);

  // The component stays mounted across sign-out (it renders null); the open
  // dialog must not survive into the next session.
  useEffect(() => {
    if (!isSignedIn) setOpenPage(null);
  }, [isSignedIn]);

  if (!isLoaded || !isSignedIn) return null;

  const initial = (identity ?? "?").slice(0, 1).toUpperCase();

  return (
    <>
      <Menu>
        <MenuTrigger
          aria-label="T3 Connect account"
          className="cursor-pointer rounded-lg p-1 outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initial}
          </span>
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel className="max-w-56 truncate">
              {identity ?? "Signed in to T3 Connect"}
            </MenuGroupLabel>
            <p className="max-w-56 px-2 pb-1 text-xs text-muted-foreground">
              Shared with the t3 CLI on this machine
            </p>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setOpenPage("t3-connect")}>
            <ServerIcon className="size-4" />
            T3 Connect
          </MenuItem>
          <MenuItem onClick={() => setOpenPage("mobile-clients")}>
            <SmartphoneIcon className="size-4" />
            Mobile clients
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void signOut()}>
            <LogOutIcon className="size-4" />
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={openPage !== null} onOpenChange={(open) => !open && setOpenPage(null)}>
        <DialogPopup
          aria-label={openPage === "mobile-clients" ? "Mobile clients" : "T3 Connect"}
          className="max-w-2xl"
        >
          <DialogPanel>
            {openPage === "mobile-clients" ? (
              <MobileClientsUserProfilePage />
            ) : (
              <T3ConnectUserProfilePage />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useT3ConnectAuth();
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
