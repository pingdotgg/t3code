import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadCommandWatch,
  type ThreadId,
} from "@t3tools/contracts";
import { EyeOffIcon, TerminalIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { useThreadProjection } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const EMPTY_WATCHES: ReadonlyArray<ThreadCommandWatch> = [];

const intervalLabel = (everyMinutes: number) =>
  everyMinutes % 60 === 0
    ? `every ${everyMinutes / 60 === 1 ? "hour" : `${everyMinutes / 60} hours`}`
    : `every ${everyMinutes === 1 ? "minute" : `${everyMinutes} min`}`;

/**
 * Thread details section listing the commands the server runs for this thread's agent
 * (`watch_command`), each with a way to stop it. Renders nothing without watches.
 */
export function ThreadDetailsCommandWatchRows(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const watches = projection?.projection.thread.commandWatches ?? EMPTY_WATCHES;
  const stop = useAtomCommand(threadEnvironment.stopCommandWatch, { reportFailure: true });
  const canOperateThread = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  if (watches.length === 0) return null;

  return (
    <ThreadDetailsSection headingId="thread-details-command-watches-heading" title="Watching">
      <ul className="m-0 list-none p-0">
        {watches.map((watch) => (
          <li
            key={watch.id}
            className={cn(
              "flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <TerminalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {watch.label}
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="truncate font-mono text-2xs text-muted-foreground">
                      {intervalLabel(watch.everyMinutes)} · {watch.command}
                    </p>
                  }
                />
                <TooltipPopup>{watch.command}</TooltipPopup>
              </Tooltip>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Stop watching ${watch.label}`}
                    disabled={!canOperateThread}
                    onClick={() =>
                      void stop({
                        environmentId: props.environmentId,
                        input: { threadId: props.threadId, watchId: watch.id },
                      })
                    }
                  >
                    <EyeOffIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Stop watching</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
