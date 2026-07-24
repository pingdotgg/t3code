import {
  BugIcon,
  GitPullRequestArrowIcon,
  ScanSearchIcon,
  TestTubeDiagonalIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

interface SuggestedTask {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly tone: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

interface DraftSuggestedTasksProps {
  readonly sourceControlAvailable: boolean;
  readonly onCheckoutPullRequest: () => void;
  readonly onTriageIssue: () => void;
  readonly onReviewChanges: () => void;
  readonly onFixFailingChecks: () => void;
}

export function DraftSuggestedTasks(props: DraftSuggestedTasksProps) {
  const tasks: ReadonlyArray<SuggestedTask> = [
    {
      title: "Check out a PR",
      description: "Open it locally or in a worktree",
      icon: GitPullRequestArrowIcon,
      tone: "text-sky-500 dark:text-sky-400",
      onSelect: props.onCheckoutPullRequest,
      disabled: !props.sourceControlAvailable,
    },
    {
      title: "Triage an issue",
      description: "Investigate scope and likely cause",
      icon: BugIcon,
      tone: "text-amber-500 dark:text-amber-400",
      onSelect: props.onTriageIssue,
      disabled: !props.sourceControlAvailable,
    },
    {
      title: "Review current changes",
      description: "Inspect the diff and flag risks",
      icon: ScanSearchIcon,
      tone: "text-violet-500 dark:text-violet-400",
      onSelect: props.onReviewChanges,
    },
    {
      title: "Fix failing checks",
      description: "Run focused checks and repair failures",
      icon: TestTubeDiagonalIcon,
      tone: "text-emerald-500 dark:text-emerald-400",
      onSelect: props.onFixFailingChecks,
    },
  ];

  return (
    <div className="pointer-events-auto mx-auto mt-6 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
      {tasks.map((task) => {
        const Icon = task.icon;
        return (
          <button
            key={task.title}
            type="button"
            onClick={task.onSelect}
            disabled={task.disabled}
            title={task.disabled ? "Available in Git repositories" : undefined}
            className={cn(
              "group min-h-20 rounded-xl border border-border/65 bg-card/45 p-3 text-left shadow-[0_1px_0_hsl(var(--border)/0.12)] backdrop-blur-sm transition-[border-color,background-color,transform,box-shadow] duration-150",
              "hover:-translate-y-0.5 hover:border-border hover:bg-card/80 hover:shadow-sm",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:pointer-events-none disabled:opacity-40 sm:min-h-24",
            )}
          >
            <Icon className={cn("size-4", task.tone)} strokeWidth={1.8} />
            <span className="mt-3 block text-[13px] font-medium leading-4 text-foreground">
              {task.title}
            </span>
            <span className="mt-1 hidden text-[11px] leading-4 text-muted-foreground/75 sm:block">
              {task.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
