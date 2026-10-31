import { Link, useLocation, useSearch } from "@tanstack/react-router";
import { ClapperboardIcon, SwatchBookIcon } from "lucide-react";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { turnScripts } from "./scenes/turnScripts";

/** The catalog's sections, by the `id` each `Section` renders with. */
const CATALOG_SECTIONS = [
  { id: "foundations", label: "Foundations" },
  { id: "buttons", label: "Buttons" },
  { id: "controls", label: "Controls" },
  { id: "inputs", label: "Inputs" },
  { id: "badges", label: "Badges and chips" },
  { id: "status", label: "Status and loading" },
  { id: "groups", label: "Groups" },
  { id: "overlays", label: "Menus and overlays" },
  { id: "palette", label: "Command palette" },
  { id: "feedback", label: "Feedback" },
  { id: "worklog", label: "Work log" },
  { id: "composer", label: "Composer parts" },
] as const;

/**
 * The app sidebar's nav on the dev design-system pages, in place of the
 * thread list: the catalog and its sections, and the turn player and its
 * scripts.
 */
export function DesignSystemSidebarNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const script = useSearch({ strict: false, select: (search) => search.script });
  const onScenes = pathname.startsWith("/design-system/scenes");
  const activeScript = script ?? turnScripts[0]?.id;

  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={!onScenes} render={<Link to="/design-system" />}>
              <SwatchBookIcon className="size-3.5" />
              <span className="truncate">Catalog</span>
            </SidebarMenuButton>
            <SidebarMenuSub>
              {CATALOG_SECTIONS.map((section) => (
                <SidebarMenuSubItem key={section.id}>
                  <SidebarMenuSubButton
                    size="sm"
                    render={<Link to="/design-system" hash={section.id} />}
                  >
                    <span>{section.label}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={onScenes} render={<Link to="/design-system/scenes" />}>
              <ClapperboardIcon className="size-3.5" />
              <span className="truncate">Turn player</span>
            </SidebarMenuButton>
            <SidebarMenuSub>
              {turnScripts.map((entry) => (
                <SidebarMenuSubItem key={entry.id}>
                  <SidebarMenuSubButton
                    size="sm"
                    isActive={onScenes && activeScript === entry.id}
                    render={<Link to="/design-system/scenes" search={{ script: entry.id }} />}
                  >
                    <span>{entry.title}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
