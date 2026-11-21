import { useNavigate, useLocation } from "@tanstack/react-router";
import { T } from "gt-react";
import { HouseIcon } from "lucide-react";
import { memo } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export const SidebarHomeEntry = memo(function SidebarHomeEntry() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = useLocation({ select: (location) => location.pathname === "/home" });
  return (
    <SidebarMenu className="mb-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({ to: "/home" });
          }}
        >
          <HouseIcon />
          <span>
            <T>Home</T>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});
