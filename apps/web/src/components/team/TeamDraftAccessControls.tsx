import {
  canCurrentMemberToggleThreadLock,
  listCreatableTeamViews,
  resolveTeamDefaultView,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, TeamViewId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { LayersIcon, LockIcon, UnlockIcon } from "lucide-react";

import {
  setTeamDraftLocked,
  setTeamDraftViewId,
  useTeamDraftAccessOptions,
  useTeamEnvironmentState,
} from "~/state/team";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function TeamDraftAccessControls({
  environmentId,
  draftKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
}) {
  const gt = useGT();
  const teamState = useTeamEnvironmentState(environmentId);
  const options = useTeamDraftAccessOptions(draftKey);
  const viewId = options.teamEnvironmentId === environmentId ? options.viewId : null;
  const locked = options.teamEnvironmentId === environmentId && options.locked;

  if (teamState.team === null || teamState.currentMember === null) {
    return null;
  }

  const creatableViews = listCreatableTeamViews(teamState);
  const defaultView = resolveTeamDefaultView(teamState);
  const selectedView =
    (viewId !== null ? creatableViews.find((view) => view.id === viewId) : undefined) ??
    defaultView ??
    creatableViews[0] ??
    null;
  const canLock = canCurrentMemberToggleThreadLock(teamState);

  if (selectedView === null && !canLock) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {selectedView !== null && creatableViews.length > 0 ? (
        <Select
          value={selectedView.id}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setTeamDraftViewId(draftKey, value as TeamViewId, environmentId);
            }
          }}
        >
          <SelectTrigger
            size="sm"
            data-testid="team-draft-view-select"
            aria-label={gt("Team view for new thread")}
          >
            <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <SelectValue>{selectedView.name}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {creatableViews.map((view) => (
              <SelectItem
                key={view.id}
                value={view.id}
                data-testid={`team-draft-view-option-${view.name}`}
              >
                {view.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}

      {canLock ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant={locked ? "secondary" : "ghost"}
                data-testid="team-draft-lock-toggle"
                aria-pressed={locked}
                aria-label={
                  locked ? gt("New thread will start locked") : gt("Start new thread locked")
                }
                onClick={() => setTeamDraftLocked(draftKey, !locked, environmentId)}
              />
            }
          >
            {locked ? (
              <LockIcon aria-hidden className="size-3.5" />
            ) : (
              <UnlockIcon aria-hidden className="size-3.5" />
            )}
            <span className="hidden sm:inline">{locked ? <T>Locked</T> : <T>Lock</T>}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {locked ? (
              <T>This thread will be created locked (only owners and admins can post).</T>
            ) : (
              <T>Create this thread locked so only owners and admins can post.</T>
            )}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
