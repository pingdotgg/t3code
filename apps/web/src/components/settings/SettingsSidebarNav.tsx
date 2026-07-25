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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "../clerk/T3ConnectSidebarSignIn";
import { useTranslation, type TranslationKey } from "../../i18n";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  labelKey: TranslationKey;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { labelKey: "nav.general", to: "/settings/general", icon: Settings2Icon },
  { labelKey: "nav.keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { labelKey: "nav.providers", to: "/settings/providers", icon: BotIcon },
  { labelKey: "nav.sourceControl", to: "/settings/source-control", icon: GitBranchIcon },
  { labelKey: "nav.connections", to: "/settings/connections", icon: Link2Icon },
  { labelKey: "nav.beta", to: "/settings/beta", icon: FlaskConicalIcon },
  { labelKey: "nav.archive", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const { t } = useTranslation();
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
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
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
                    <span className="truncate">{t(item.labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
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
                <span>{t("nav.back")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <T3ConnectSidebarAvatar />
        </div>
      </SidebarFooter>
    </>
  );
}
