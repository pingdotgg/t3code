import { IconArrowTurnUpLeft as ArrowTurnUpLeftIcon } from "symbols-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { SETTINGS_NAV_ITEMS, resolveSettingsPathname } from "./settingsNavigation";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentPath = resolveSettingsPathname(pathname);
  const handleSectionClick = useCallback(
    (to: (typeof SETTINGS_NAV_ITEMS)[number]["to"]) => {
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
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = currentPath === item.to;
              const iconClassName = item.iconUsesFill
                ? isActive
                  ? "size-4 shrink-0 fill-current text-foreground"
                  : "size-4 shrink-0 fill-current text-muted-foreground/60"
                : isActive
                  ? "size-4 shrink-0 text-foreground"
                  : "size-4 shrink-0 text-muted-foreground/60";

              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    className={
                      isActive
                        ? "text-ui-sm gap-2.5 px-2.5 py-2 text-left font-medium text-foreground"
                        : "text-ui-sm gap-2.5 px-2.5 py-2 text-left text-muted-foreground/70 hover:text-foreground/80"
                    }
                    isActive={isActive}
                    onClick={() => handleSectionClick(item.to)}
                    size="sm"
                  >
                    <Icon className={iconClassName} />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
              size="sm"
            >
              <ArrowTurnUpLeftIcon className="size-2.5 fill-current" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
