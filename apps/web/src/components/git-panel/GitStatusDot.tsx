import { cn } from "~/lib/utils";
import type { WorkspaceStatusLevel } from "./GitPanel.logic";

interface GitStatusDotProps {
  level: WorkspaceStatusLevel;
  pulse?: boolean;
  className?: string;
}

export function GitStatusDot({ level, pulse, className }: GitStatusDotProps) {
  const colors: Record<WorkspaceStatusLevel, string> = {
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    error: "bg-red-500",
    neutral: "bg-neutral-400 dark:bg-neutral-500",
    info: "bg-blue-500",
  };

  return (
    <span className={cn("relative flex size-2", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            colors[level],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", colors[level])} />
    </span>
  );
}
