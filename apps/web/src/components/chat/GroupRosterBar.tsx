import { useAtomValue } from "@effect/atom-react";
import type { ThreadGroup, ThreadGroupSeat } from "@t3tools/client-runtime/state/thread-group";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon, StarIcon, UsersIcon } from "lucide-react";
import { useGT } from "gt-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerBanner } from "./ComposerBanner";
import {
  reportGroupCommandFailure,
  requestGroupInvite,
  useCanInviteToGroup,
} from "./groupAvailability";

function SeatChip(props: { threadRef: ScopedThreadRef; seat: ThreadGroupSeat }) {
  const gt = useGT();
  const { threadRef, seat } = props;
  const canRemove = useAtomValue(
    orchestrationEnvironment.removeFromGroup.permissionAtom(threadRef.environmentId),
  );
  const removeFromGroup = useAtomCommand(orchestrationEnvironment.removeFromGroup);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="compact"
            aria-label={gt("{label}, group member", { label: seat.label })}
          />
        }
      >
        {seat.label}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem
          onClick={() => useRightPanelStore.getState().openThread(threadRef, seat.threadId)}
        >
          {gt("Open work")}
        </MenuItem>
        <MenuItem
          disabled={!canRemove}
          onClick={() =>
            void removeFromGroup({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, seatThreadId: seat.threadId },
            }).then((result) =>
              reportGroupCommandFailure(
                gt("Could not remove {label}", { label: seat.label }),
                result,
              ),
            )
          }
        >
          {gt("Remove")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Who is in the thread, above its composer: the primary, then each seat, then the way out. It stays
 * while Group conversations is off, so nobody is stranded in a group they cannot end.
 */
export function GroupRosterBar(props: { threadRef: ScopedThreadRef; group: ThreadGroup }) {
  const gt = useGT();
  const { threadRef, group } = props;
  const canInvite = useCanInviteToGroup(threadRef.environmentId);
  const canEnd = useAtomValue(
    orchestrationEnvironment.endGroup.permissionAtom(threadRef.environmentId),
  );
  const endGroup = useAtomCommand(orchestrationEnvironment.endGroup);
  const seats = group.seats.filter((seat) => seat.status === "seated");
  const unanswered = group.discussion === null && group.closedBecause === "budget";
  return (
    <ComposerBanner.Root variant="default" density="comfortable" data-group-roster="true">
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon>
          <UsersIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="inline-flex shrink-0 items-center gap-1 px-1.5 text-xs font-medium sm:text-sm">
            <StarIcon className="size-3 fill-current" aria-hidden />
            <span aria-hidden>{group.primary.label}</span>
            <span className="sr-only">
              {gt("{label}, primary", { label: group.primary.label })}
            </span>
          </span>
          {seats.map((seat) => (
            <SeatChip key={seat.threadId} threadRef={threadRef} seat={seat} />
          ))}
          {canInvite ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={gt("Invite a model")}
              onClick={() => requestGroupInvite(threadRef)}
            >
              <PlusIcon />
            </Button>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={!canEnd}
            onClick={() =>
              void endGroup({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId },
              }).then((result) => reportGroupCommandFailure(gt("Could not end the group"), result))
            }
          >
            {gt("End group · Continue with {label}", { label: group.primary.label })}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {unanswered ? (
        <p className="px-2 pb-1 text-muted-foreground" role="status">
          {gt("A member has unanswered replies. Any message continues.")}
        </p>
      ) : null}
    </ComposerBanner.Root>
  );
}
