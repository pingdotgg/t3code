import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { HandIcon } from "lucide-react";

import { useQuietThreadShells } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarAttentionMenu() {
  const gt = useGT();
  const threads = useQuietThreadShells();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pending = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest === "approval" ||
        thread.pendingSubagentRequest === "user_input" ||
        (thread.pendingGuestMessageCount ?? 0) > 0),
  );

  return (
    <SidebarMenuItem>
      <Menu>
        <MenuTrigger render={<SidebarMenuButton />}>
          <HandIcon />
          <span>
            <T>Needs you</T>
          </span>
          <Badge size="sm" variant={pending.length > 0 ? "warning" : "secondary"}>
            {pending.length}
          </Badge>
        </MenuTrigger>
        <MenuPopup align="start" className="w-64">
          {pending.length === 0 ? (
            <MenuItem disabled>
              <T>No threads need your attention</T>
            </MenuItem>
          ) : (
            pending.map((thread) => (
              <MenuItem
                key={`${thread.environmentId}:${thread.id}`}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread.environmentId, threadId: thread.id },
                  });
                }}
              >
                <span className="truncate">{thread.title || gt("New thread")}</span>
              </MenuItem>
            ))
          )}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
