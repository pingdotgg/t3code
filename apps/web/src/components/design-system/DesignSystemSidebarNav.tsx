import { Link } from "@tanstack/react-router";
import { SwatchBookIcon } from "lucide-react";

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

/** The catalog sections in the app sidebar. */
export function DesignSystemSidebarNav() {
  return (
    <SidebarContent className="overflow-x-hidden">
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive render={<Link to="/design-system" />}>
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
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
