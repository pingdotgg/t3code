import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WaypointsIcon } from "lucide-react";
import { T } from "gt-react";

import { cn } from "../../lib/utils";
import { projectCode } from "../../state/projectCode";
import { serverEnvironment } from "../../state/server";
import { CodeIndexBadge } from "../files/CodeIndexBadge";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/** Freshness of the code index for this thread's checkout (its worktree when it has one). */
export function ThreadCodeIndexRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQuery = useAtomValue(projectCode.freshness.permissionAtom(props.environmentId));
  if (
    config?.environment.capabilities.projectCode !== true ||
    config.environment.capabilities.projectCodeFreshness !== true ||
    !canQuery
  )
    return null;
  return (
    <div
      className={cn(
        "flex h-8 items-center text-sm font-medium text-foreground/80",
        THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
      )}
    >
      <WaypointsIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className="min-w-0 flex-1 truncate">
        <T>Code index</T>
      </span>
      <CodeIndexBadge
        environmentId={props.environmentId}
        projectId={props.projectId}
        threadId={props.threadId}
      />
    </div>
  );
}
