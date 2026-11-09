import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSourceControlWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ComposerContextLabel } from "./ComposerContextLabel";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function BranchToolbarRemoteSelector({
  cwd,
  displayMode = "toolbar",
  environmentId,
}: {
  cwd: string;
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
}) {
  const isPanel = displayMode === "panel";
  const composerFloatingLayerProps = useComposerMenuProps();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const statusQuery = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const setPushRemote = useAtomCommand(vcsEnvironment.setPushRemote, { reportFailure: false });

  const { remotes, pushRemote, refName } = statusQuery.data ?? {};
  if (!remotes || !refName) return null;

  const selectRemote = async (remoteName: string) => {
    if (remoteName === pushRemote) return;
    const result = await setPushRemote({
      environmentId,
      input: { cwd, refName, remoteName },
    });
    if (result._tag === "Success") {
      statusQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to change push remote.",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl part="select" /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 flex-initial"}
        disabled={!canWriteSourceControl}
        aria-label={`Push remote: ${pushRemote ?? "not chosen"}`}
        data-composer-context-control
      >
        <CloudIcon className={cn("size-3 shrink-0", isPanel && THREAD_DETAILS_PANEL_ICON_CLASS)} />
        <ComposerContextLabel displayMode={displayMode}>
          {pushRemote ?? "Choose remote"}
        </ComposerContextLabel>
      </MenuTrigger>
      <MenuPopup
        align={isPanel ? "start" : "end"}
        side={isPanel ? "bottom" : "top"}
        className={isPanel ? "w-(--anchor-width)" : undefined}
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        <MenuGroup>
          <MenuGroupLabel>Push to</MenuGroupLabel>
          <MenuRadioGroup
            value={pushRemote ?? ""}
            onValueChange={(remoteName: string) => void selectRemote(remoteName)}
          >
            {remotes.map((remoteName) => (
              <MenuRadioItem key={remoteName} value={remoteName}>
                {remoteName}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
