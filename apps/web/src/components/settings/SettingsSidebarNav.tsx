import { useCallback, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "../clerk/T3ConnectSidebarSignIn";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/environment"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export type SettingsNavItem = {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  label: "Client" | "Environment";
  items: ReadonlyArray<SettingsNavItem>;
}> = [
  {
    label: "Client",
    items: [
      { label: "General", to: "/settings/general", icon: Settings2Icon },
      { label: "Connections", to: "/settings/connections", icon: Link2Icon },
      { label: "Beta", to: "/settings/beta", icon: FlaskConicalIcon },
      { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
    ],
  },
  {
    label: "Environment",
    items: [
      { label: "General", to: "/settings/environment", icon: Settings2Icon },
      { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
      { label: "Providers", to: "/settings/providers", icon: BotIcon },
      {
        label: "Source Control",
        to: "/settings/source-control",
        icon: GitBranchIcon,
      },
    ],
  },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup className="px-2 py-2 first:pt-3" key={group.label}>
            <SidebarGroupLabel className="h-6 px-2 text-[10px] font-semibold tracking-[0.08em] text-sidebar-muted-foreground/55 uppercase">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      size="sm"
                      isActive={isActive}
                      className={
                        isActive
                          ? "h-8 items-center gap-2 rounded-md bg-sidebar-row-active px-2 py-1.5 text-left text-sm font-medium text-sidebar-foreground"
                          : "h-8 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      }
                      onClick={() => handleSectionClick(item.to)}
                    >
                      <Icon
                        className={
                          isActive
                            ? "size-4 shrink-0 text-sidebar-foreground"
                            : "size-4 shrink-0 text-sidebar-muted-foreground/60"
                        }
                      />
                      <span className="truncate">{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-2">
        <T3ConnectSidebarSignIn />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
          <SidebarMenu className="min-w-0">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                onClick={handleBackClick}
              >
                <ArrowLeftIcon className="size-4" />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <T3ConnectSidebarAvatar />
        </div>
      </SidebarFooter>
    </>
  );
}
