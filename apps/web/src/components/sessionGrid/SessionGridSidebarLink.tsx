import { useLocation, useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export const SessionGridSidebarLink = memo(function SessionGridSidebarLink() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const openGrid = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    if (pathname === "/grid") return;
    void navigate({ to: "/grid", search: {} });
  }, [isMobile, navigate, pathname, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={pathname === "/grid"}
        onClick={openGrid}
        tooltip="Open session grid"
      >
        <LayoutGridIcon />
        <span>Session grid</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
