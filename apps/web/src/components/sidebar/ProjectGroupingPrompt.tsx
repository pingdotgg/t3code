import { GitMergeIcon } from "lucide-react";

import { resolveProjectGroupingEnvironmentLabels } from "../../projectGroupingPrompt.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

interface ProjectGroupingPromptProps {
  readonly group: SidebarProjectSnapshot;
  readonly onGroup: () => void;
  readonly onKeepSeparate: () => void;
}

export function ProjectGroupingPrompt({
  group,
  onGroup,
  onKeepSeparate,
}: ProjectGroupingPromptProps) {
  const environmentLabels = resolveProjectGroupingEnvironmentLabels(group);
  const environmentDescription =
    environmentLabels.length > 1 ? environmentLabels.join(" and ") : "multiple environments";

  return (
    <Alert
      variant="info"
      controlAlignment="first-line"
      className="mx-1 text-xs"
      data-testid="project-grouping-prompt"
    >
      <GitMergeIcon aria-hidden />
      <AlertTitle>Group this repository?</AlertTitle>
      <AlertDescription>
        <span>
          {group.displayName} is available on {environmentDescription}. Grouping keeps one project
          and lets new threads choose where to run.
        </span>
        <div className="flex flex-wrap justify-end gap-1">
          <Button size="xs" variant="outline" onClick={onKeepSeparate}>
            Keep separate
          </Button>
          <Button size="xs" onClick={onGroup}>
            Group projects
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
