import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { groupThreads } from "@t3tools/client-runtime/state/thread-grouping";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { T } from "gt-react";
import { HouseIcon } from "lucide-react";
import { memo } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { SidebarCrewBlock } from "./SidebarCrewBlock";

/** Home's entry, with Home's crew under it as any Bot's crew sits under its row. */
export const SidebarHomeEntry = memo(function SidebarHomeEntry(props: {
  /** Home threads and their crew, from `homeThreads`. */
  threads: ReadonlyArray<EnvironmentThreadShell>;
  routeThreadKey: string | null;
  isCrewFolded: (leaderKey: string) => boolean;
  onToggleCrew: (leaderKey: string, folded: boolean) => void;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = useLocation({ select: (location) => location.pathname === "/home" });
  const crews = [...groupThreads(props.threads).groupByLeaderKey];
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
      {crews.map(([leaderKey, group]) => (
        <SidebarCrewBlock
          key={leaderKey}
          leaderKey={leaderKey}
          group={group}
          folded={props.isCrewFolded(leaderKey)}
          routeThreadKey={props.routeThreadKey}
          onToggle={props.onToggleCrew}
          onNavigate={props.onNavigate}
          onContextMenu={props.onContextMenu}
        />
      ))}
    </SidebarMenu>
  );
});
