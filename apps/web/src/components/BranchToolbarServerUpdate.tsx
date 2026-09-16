import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../versionSkew";
import { ServerUpdateAction } from "./ServerUpdateAction";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * "Update available" is a fact about the server this thread runs on, so it sits
 * next to that server's name in the composer context strip. Null while the
 * server matches the client, is ahead of it, or has an update in flight (the
 * thread's notice stack carries progress and failure).
 */
export function useServerUpdateAvailability(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const mismatch = resolveServerConfigVersionMismatch(environment?.serverConfig);
  if (environmentId === null || !environment || !mismatch || updateState.status !== "idle") {
    return null;
  }
  return {
    environmentId,
    serverLabel: environment.label,
    serverVersion: mismatch.serverVersion,
    targetVersion: mismatch.clientVersion,
    selfUpdate: resolveServerSelfUpdateCapability(environment.serverConfig),
    desktopAppUpdate: supportsDesktopAppUpdate(environment.serverConfig),
    threadContinuation: supportsServerUpdateThreadContinuation(environment.serverConfig),
  };
}

export type ServerUpdateAvailability = NonNullable<ReturnType<typeof useServerUpdateAvailability>>;

/**
 * One word after the server name, in full foreground while the rest of the
 * strip stays muted. The word is the notice and the action. It only exists
 * while an update is waiting, so an up-to-date server adds nothing to the
 * strip. The tooltip carries the versions, and says so when the click copies
 * a command instead of updating.
 */
export function BranchToolbarServerUpdate({
  update,
}: {
  readonly update: ServerUpdateAvailability;
}) {
  const manual = update.selfUpdate === null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex shrink-0" data-composer-context-control />}
      >
        <ServerUpdateAction
          environmentId={update.environmentId}
          serverLabel={update.serverLabel}
          selfUpdate={update.selfUpdate}
          desktopAppUpdate={update.desktopAppUpdate}
          threadContinuation={update.threadContinuation}
          targetVersion={update.targetVersion}
          label="Update"
          manualLabel="Update"
          variant="ghost"
          size="xs"
          className="font-normal text-xs!"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {update.serverLabel} runs {update.serverVersion}, this client is {update.targetVersion}.
        {manual ? " Copies the update command to run there." : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
