import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useGT } from "gt-react";
import { useState } from "react";

import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { isScratchProjectGroup, scopeProjectSettingsGroup } from "./ProjectSettingsPanel.logic";
import { useRemoveProjectMembers } from "./useRemoveProjectMembers";

/** Same pin, archive and remove actions as the project page, scoped like the list. */
export function ProjectRowMenu({
  group,
  machine,
  className,
}: {
  group: SidebarProjectSnapshot;
  /** The list's environment filter; removal only reaches checkouts on it. */
  machine: string | undefined;
  className?: string;
}) {
  const gt = useGT();
  const allMembers = group.memberProjects;
  const members =
    machine === undefined
      ? allMembers
      : allMembers.filter((member) => member.environmentId === machine);
  const hasOtherMembers = members.length < allMembers.length;
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const canOrganize =
    allMembers.every((member) => editableIds.has(member.environmentId)) &&
    canOrganizeProjectGroup(allMembers);
  const isScratch = isScratchProjectGroup(group);
  const canRemove =
    !isScratch &&
    members.length > 0 &&
    members.every((member) => editableIds.has(member.environmentId));
  const removeMembers = useRemoveProjectMembers({
    group: members.length > 0 ? scopeProjectSettingsGroup(group, members) : group,
    allMembers,
    hasOtherMembers,
    navigateAfterRemoval: false,
  });
  const [isBusy, setIsBusy] = useState(false);
  if (!canOrganize && !canRemove) return null;

  const organize = async (
    input: { pinned: boolean } | { archived: boolean },
    failureTitle: string,
  ) => {
    setIsBusy(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsBusy(false);
  };

  return (
    <Menu>
      <MenuTrigger
        className={className}
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            disabled={isBusy}
            aria-label={gt("More actions for {project}", { project: group.displayName })}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {canOrganize ? (
          <>
            <MenuItem
              onClick={() =>
                void organize(
                  { pinned: !group.pinned },
                  group.pinned ? gt("Failed to unpin project") : gt("Failed to pin project"),
                )
              }
            >
              {group.pinned ? <PinOffIcon /> : <PinIcon />}
              {group.pinned ? gt("Unpin") : gt("Pin")}
            </MenuItem>
            {isScratch && !group.archived ? null : (
              <MenuItem
                onClick={() =>
                  void organize(
                    { archived: !group.archived },
                    group.archived
                      ? gt("Failed to unarchive project")
                      : gt("Failed to archive project"),
                  )
                }
              >
                {group.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {group.archived ? gt("Unarchive") : gt("Archive")}
              </MenuItem>
            )}
          </>
        ) : null}
        {canOrganize && canRemove ? <MenuSeparator /> : null}
        {canRemove ? (
          <MenuItem variant="destructive" onClick={() => void removeMembers(members)}>
            <Trash2Icon />
            {hasOtherMembers
              ? gt("Remove from {environment}…", {
                  environment: members[0]?.environmentLabel ?? gt("this environment"),
                })
              : gt("Remove project…")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
