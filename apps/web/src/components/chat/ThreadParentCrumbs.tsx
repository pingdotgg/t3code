import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { threadBreadcrumbLinks } from "../AgentThreadTree.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/**
 * Header crumbs for a child thread (toolboxmd/t3code#17): the parent title
 * links back to the parent, and a compact menu switches between siblings.
 * Renders nothing for threads the user started.
 */
export function ThreadParentCrumbs({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const shells = useThreadShells();
  const navigate = useNavigate();
  const links = useMemo(
    () =>
      threadBreadcrumbLinks(
        threadId,
        shells.filter((shell) => shell.environmentId === environmentId),
      ),
    [environmentId, shells, threadId],
  );
  if (links === null) return null;
  const siblings = links.siblings.filter((sibling) => sibling.id !== threadId);
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: links.parent.id }}
          aria-label={`Open parent thread ${links.parent.title}`}
          className="inline-flex min-w-0 max-w-full items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="thread-parent-crumb"
        >
          <WorkspaceBreadcrumbText className="max-w-48">
            {links.parent.title}
          </WorkspaceBreadcrumbText>
        </Link>
        {siblings.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Switch to one of ${siblings.length} sibling threads`}
                />
              }
            >
              <ChevronsUpDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="start" aria-label="Sibling threads">
              {siblings.map((sibling) => (
                <MenuItem
                  key={sibling.id}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: sibling.id },
                    })
                  }
                >
                  <MenuItemLabel>{sibling.title}</MenuItemLabel>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
