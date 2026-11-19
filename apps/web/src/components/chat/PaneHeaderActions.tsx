import type { ProjectId } from "@t3tools/contracts";

import { ProjectAutomationsHeaderControl } from "./ThreadAutomationsPanel";
import type { ThreadDetailsPanel } from "./ThreadDetailsPanel";

/** Project automation actions in the pane header. */
export function PaneHeaderActions(
  props: Pick<
    Parameters<typeof ThreadDetailsPanel>[0],
    "environmentId" | "threadId" | "draftId" | "activeProjectName"
  > & { readonly projectId: ProjectId | null },
) {
  if (!props.activeProjectName) return null;

  return (
    <div className="hidden min-w-0 shrink-0 items-center gap-1.5 lg:flex">
      {props.projectId ? (
        <ProjectAutomationsHeaderControl
          environmentId={props.environmentId}
          projectId={props.projectId}
          projectName={props.activeProjectName}
        />
      ) : null}
    </div>
  );
}
