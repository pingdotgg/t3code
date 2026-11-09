import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";

import type { ProjectScriptRunStatus } from "../../projectScriptRuns";

export function ProjectScriptRunStatusIcon({
  status,
  className,
}: {
  readonly status: ProjectScriptRunStatus | null;
  readonly className?: string | undefined;
}) {
  const iconClassName = className ?? "size-3.5";
  if (status === "failed") return <CircleAlertIcon className={iconClassName} aria-label="Failed" />;
  if (status === "running" || status === "starting")
    return <SquareIcon className={iconClassName} aria-label="Running" />;
  if (status === "succeeded")
    return <CircleCheckIcon className={iconClassName} aria-label="Succeeded" />;
  if (status === "stopped")
    return <CircleSlashIcon className={iconClassName} aria-label="Stopped" />;
  if (status === "lost")
    return <CircleHelpIcon className={iconClassName} aria-label="Terminal lost" />;
  return <PlayIcon className={iconClassName} aria-label="Run" />;
}
