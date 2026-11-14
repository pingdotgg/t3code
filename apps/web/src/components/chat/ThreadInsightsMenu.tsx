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
}: {
  parent: ScopedThreadRef;
  target: ScopedThreadRef;
}) {
  const supported = useServerConfigs().get(target.environmentId)?.threadInsights === true;
  const canRead = useEnvironmentScope(target.environmentId, AuthOrchestrationReadScope);
  if (!supported || !canRead) return null;
  const open = (section: "tasks" | "usage") =>
    useRightPanelStore.getState().openThreadInsights(parent, target, section);
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Tasks and usage" />}>
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={() => open("tasks")}>
          <ListTodoIcon />
          View tasks
        </MenuItem>
        <MenuItem onClick={() => open("usage")}>
          <ChartNoAxesCombinedIcon />
          View usage
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
