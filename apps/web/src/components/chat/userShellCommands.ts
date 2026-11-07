import { CommandId, type EnvironmentId, type ThreadId, type TurnItemId } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

/** Running a `!` command needs the grants stopping one does: operate and terminal. */
export const shellCommandPermissionAtom = (environmentId: EnvironmentId | null) =>
  orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId, {
    type: "shell-command.stop",
  });

interface UserShellTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}

export function useUserShellCommandActions() {
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand);
  return {
    stop: ({ environmentId, threadId, itemId }: UserShellTarget) =>
      dispatch({
        environmentId,
        input: {
          type: "shell-command.stop",
          commandId: CommandId.make(randomUUID()),
          threadId,
          itemId,
        },
      }),
    setDelivery: (
      { environmentId, threadId, itemId }: UserShellTarget,
      delivery: "pending" | "dismissed",
    ) =>
      dispatch({
        environmentId,
        input: {
          type: "shell-command.delivery.set",
          commandId: CommandId.make(randomUUID()),
          threadId,
          itemId,
          delivery,
        },
      }),
  };
}
