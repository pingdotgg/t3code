import type { EnvironmentId } from "@t3tools/contracts";
import { FolderOpenIcon, MessageSquarePlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useFileContextMenu } from "~/fileContextMenu";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { isAbsolutePath } from "@t3tools/shared/path";

import { addFileMentionToChat } from "./addFileToChat";

/**
 * The row under a media preview: the file's metadata line, then Add to chat
 * and Reveal. Reveal opens the host's file manager, so it only appears for the
 * primary (local) environment and when its server can open a file manager.
 */
export function FileMediaDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly metadata: string | null;
}) {
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(props.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const revealLabel =
    props.environmentId === primaryEnvironmentId
      ? fileContextMenu.capabilities.revealLabel
      : undefined;
  const canAddToChat = composerRef !== null && !isAbsolutePath(props.relativePath);
  return (
    <div className="flex min-h-7 w-full items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-caption text-dim-foreground">
        {props.metadata}
      </span>
      {canAddToChat ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={() => addFileMentionToChat(composerRef, props.relativePath)}
        >
          <MessageSquarePlusIcon aria-hidden />
          Add to chat
        </Button>
      ) : null}
      {revealLabel !== undefined ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() =>
                  void fileContextMenu.activate("reveal-in-folder", {
                    environmentId: props.environmentId,
                    filePath: props.relativePath,
                    workspaceRoot: props.cwd,
                  })
                }
              />
            }
          >
            <FolderOpenIcon aria-hidden />
            Reveal
          </TooltipTrigger>
          <TooltipPopup>{revealLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
