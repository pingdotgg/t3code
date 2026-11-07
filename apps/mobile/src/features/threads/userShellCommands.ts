import {
  CommandId,
  parseShellCommand,
  type EnvironmentId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

/** Running a `!` command needs the grants stopping one does: operate and terminal. */
export const shellCommandPermissionAtom = (environmentId: EnvironmentId | null) =>
  orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId, {
    type: "shell-command.stop",
  });

/** Sends trim the prompt, so leading whitespace before `!` still makes a shell command. */
export function isShellModePrompt(text: string): boolean {
  return text.trimStart().startsWith("!");
}

export function withoutShellPrefix(text: string): { text: string; bangIndex: number } {
  const bangIndex = text.indexOf("!");
  return { text: text.slice(0, bangIndex) + text.slice(bangIndex + 1), bangIndex };
}

/** The server runs `!` text as a command, so it neither carries context nor attachments. */
export function shellCommandSendBlock(input: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly connected: boolean;
  readonly hasAttachmentsOrContext: boolean;
}): { readonly title: string; readonly detail: string } | null {
  if (parseShellCommand(input.text) === null) return null;
  if (input.connected && !appAtomRegistry.get(shellCommandPermissionAtom(input.environmentId))) {
    return {
      title: "Shell command not sent",
      detail: "This connection needs terminal access to run commands here.",
    };
  }
  if (input.hasAttachmentsOrContext) {
    return {
      title: "Shell commands take text only",
      detail: "Remove the attachments and context, then send it again.",
    };
  }
  return null;
}

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
          commandId: CommandId.make(uuidv4()),
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
          commandId: CommandId.make(uuidv4()),
          threadId,
          itemId,
          delivery,
        },
      }),
  };
}
