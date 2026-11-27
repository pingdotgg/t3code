import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TeamViewId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon, ChevronDownIcon, LayersIcon, LockIcon, UnlockIcon } from "lucide-react";
import { useState } from "react";

import { teamEnvironment, useTeamThreadAccessState } from "~/state/team";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTeamThreadAccessActions } from "./useTeamThreadAccessActions";

export function TeamThreadAccessControls({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const access = useTeamThreadAccessState(environmentId, threadId);
  const targetTeamEnvironmentId = access.teamEnvironmentId ?? environmentId;
  const canSetViewScope = useAtomValue(
    teamEnvironment.setThreadView.permissionAtom(targetTeamEnvironmentId),
  );
  const canSetLockScope = useAtomValue(
    teamEnvironment.setThreadLocked.permissionAtom(targetTeamEnvironmentId),
  );
  const { setThreadView, setThreadLocked } = useTeamThreadAccessActions();
  const [pendingViewKey, setPendingViewKey] = useState<string | null>(null);
  const [pendingLockKey, setPendingLockKey] = useState<string | null>(null);

  if (!access.isTeamThread) return null;

  const currentThreadKey = `${targetTeamEnvironmentId}:${threadId}`;
  const isUpdatingView = pendingViewKey === currentThreadKey;
  const isUpdatingLock = pendingLockKey === currentThreadKey;
  const canEditView = access.canChangeView && canSetViewScope && access.accessibleViews.length > 0;
  const canEditLock = access.canToggleLock && canSetLockScope;

  const handleSelectView = async (viewId: TeamViewId) => {
    if (isUpdatingView || !canEditView || access.view?.id === viewId) return;
    setPendingViewKey(currentThreadKey);
    await setThreadView({ environmentId: targetTeamEnvironmentId, threadId, viewId }).catch(
      () => false,
    );
    setPendingViewKey((active) => (active === currentThreadKey ? null : active));
  };

  const handleToggleLock = async () => {
    if (isUpdatingLock || !canEditLock) return;
    setPendingLockKey(currentThreadKey);
    await setThreadLocked({
      environmentId: targetTeamEnvironmentId,
      threadId,
      locked: !access.locked,
    }).catch(() => false);
    setPendingLockKey((active) => (active === currentThreadKey ? null : active));
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {access.view ? (
        canEditView ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="team-thread-view-pill"
                  aria-label={gt("Change thread view ({viewName})", {
                    viewName: access.view.name,
                  })}
                  disabled={isUpdatingView}
                />
              }
            >
              <LayersIcon aria-hidden className="size-3.5" />
              <span className="max-w-28 truncate">{access.view.name}</span>
              <ChevronDownIcon aria-hidden className="size-3 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="end">
              {access.accessibleViews.map((candidate) => {
                const isSelected = candidate.id === access.view?.id;
                return (
                  <MenuItem
                    key={candidate.id}
                    data-testid={`team-thread-view-option-${candidate.name}`}
                    onClick={() => void handleSelectView(candidate.id)}
                  >
                    <CheckIcon
                      aria-hidden
                      className={isSelected ? "size-3.5 opacity-100" : "size-3.5 opacity-0"}
                    />
                    <span className="truncate">{candidate.name}</span>
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        ) : (
          <Badge variant="outline" size="sm" data-testid="team-thread-view-pill">
            <LayersIcon aria-hidden className="size-3" />
            <span className="max-w-28 truncate">{access.view.name}</span>
          </Badge>
        )
      ) : null}

      {canEditLock ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant={access.locked ? "secondary" : "ghost"}
                data-testid="team-thread-lock-button"
                data-locked={access.locked ? "true" : "false"}
                aria-pressed={access.locked}
                aria-label={access.locked ? gt("Unlock thread") : gt("Lock thread")}
                disabled={isUpdatingLock}
                onClick={() => void handleToggleLock()}
              />
            }
          >
            {access.locked ? (
              <LockIcon aria-hidden className="size-3.5" />
            ) : (
              <UnlockIcon aria-hidden className="size-3.5" />
            )}
            <span className="hidden sm:inline">{access.locked ? <T>Locked</T> : <T>Lock</T>}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {access.locked ? (
              <T>Thread is locked. Only owners and admins can post. Click to unlock.</T>
            ) : (
              <T>Lock this thread so only owners and admins can post.</T>
            )}
          </TooltipPopup>
        </Tooltip>
      ) : access.locked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="warning" size="sm" data-testid="team-thread-locked-badge">
                <LockIcon aria-hidden className="size-3" />
                <T>Locked</T>
              </Badge>
            }
          />
          <TooltipPopup side="bottom">
            <T>This thread is locked. Only team owners and admins can post.</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
