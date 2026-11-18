import { T, useGT } from "gt-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useEnvironmentScope } from "../../state/session";
import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { ListTodoIcon, ChartNoAxesCombinedIcon, MoreHorizontalIcon } from "lucide-react";
import { useServerConfigs } from "../../state/entities";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function ThreadInsightsMenu({
  parent,
  target,
  placement = "inline",
}: {
  parent: ScopedThreadRef;
  target: ScopedThreadRef;
  placement?: "inline" | "overlay";
}) {
  const gt = useGT();
  const supported = useServerConfigs().get(target.environmentId)?.threadInsights === true;
  const canRead = useEnvironmentScope(target.environmentId, AuthOrchestrationReadScope);
  if (!supported || !canRead) return null;
  const open = (section: "tasks" | "usage") =>
    useRightPanelStore.getState().openThreadInsights(parent, target, section);
  const menu = (
    <Menu>
      <MenuTrigger
        render={
          placement === "overlay" ? (
            <ThreadDetailsControl part="icon" aria-label={gt("Tasks and usage")} />
          ) : (
            <Button size="icon-xs" variant="ghost" aria-label={gt("Tasks and usage")} />
          )
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={() => open("tasks")}>
          <ListTodoIcon />
          <T>View tasks</T>
        </MenuItem>
        <MenuItem onClick={() => open("usage")}>
          <ChartNoAxesCombinedIcon />
          <T>View usage</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
  return placement === "overlay" ? (
    <div
      data-slot="thread-insights-menu"
      className="pointer-events-none absolute inset-y-0 right-1 z-10 flex items-center opacity-0 group-hover/lineage:pointer-events-auto group-hover/lineage:opacity-100 group-focus-within/lineage:pointer-events-auto group-focus-within/lineage:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
    >
      {menu}
    </div>
  ) : (
    menu
  );
}
