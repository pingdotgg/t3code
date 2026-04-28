import { IconArrowTurnUpLeft as ArrowTurnUpLeftIcon } from "symbols-react";
import { useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "../ui/sidebar";
import { SETTINGS_NAV_ITEMS, resolveSettingsPathname } from "./settingsNavigation";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentPath = resolveSettingsPathname(pathname);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = currentPath === item.to;
              const iconColorClassName = item.iconUsesFill
                ? isActive
                  ? "size-4 shrink-0 fill-current text-foreground"
                  : "size-4 shrink-0 fill-current text-muted-foreground/60"
                : isActive
                  ? "size-4 shrink-0 text-foreground"
                  : "size-4 shrink-0 text-muted-foreground/60";
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => void navigate({ to: item.to, replace: true })}
                  >
                    <Icon className={iconColorClassName} />
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
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => window.history.back()}
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
