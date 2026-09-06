import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { FolderGit2Icon, FolderIcon, GitBranchIcon } from "lucide-react";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { cn } from "~/lib/utils";

/**
 * Flip this while reviewing command-palette thread subtitles.
 * - favicon-workspace-harness: favicon + Folder/FolderGit2 + branch + harness (default)
 * - favicon-workspace: same without harness
 * - favicon-branch-harness: GitBranch for local, FolderGit2 for worktrees, + harness
 */
export type ThreadCommandSubtitleVariant =
  | "favicon-workspace-harness"
  | "favicon-workspace"
  | "favicon-branch-harness";

const THREAD_COMMAND_SUBTITLE_VARIANT: ThreadCommandSubtitleVariant = "favicon-workspace-harness";

export const COMMAND_PALETTE_META_ICON_CLASS = "size-3 shrink-0 text-muted-foreground/70";

export function CommandPaletteMetaDot() {
  return <span className="shrink-0 text-muted-foreground/50">·</span>;
}

function WorkspaceIcon(props: { variant: ThreadCommandSubtitleVariant; isWorktree: boolean }) {
  if (props.isWorktree) {
    return <FolderGit2Icon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />;
  }
  if (props.variant === "favicon-branch-harness") {
    return <GitBranchIcon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />;
  }
  return <FolderIcon className={COMMAND_PALETTE_META_ICON_CLASS} aria-hidden />;
}

export function ThreadCommandSubtitle(props: {
  environmentId: EnvironmentId;
  projectCwd: string | null;
  projectFaviconPath?: string | null;
  projectIcon?: import("@t3tools/contracts").ProjectIconOverride | null;
  projectTitle: string | null;
  branch: string | null;
  worktreePath: string | null;
  isCurrent: boolean;
  driverKind?: ProviderDriverKind | null;
  providerDisplayName?: string | null;
  variant?: ThreadCommandSubtitleVariant;
  className?: string;
}) {
  const variant = props.variant ?? THREAD_COMMAND_SUBTITLE_VARIANT;
  const isWorktree = props.worktreePath != null && props.worktreePath.trim().length > 0;
  const showHarness =
    variant !== "favicon-workspace" && props.driverKind != null && props.providerDisplayName;

  const projectLabel = props.projectTitle?.trim() || null;
  const branchLabel = props.branch?.trim() || null;

  if (!projectLabel && !branchLabel && !props.isCurrent && !showHarness) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground/70",
        props.className,
      )}
    >
      {projectLabel ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          {props.projectCwd ? (
            <ProjectFavicon
              environmentId={props.environmentId}
              cwd={props.projectCwd}
              projectName={projectLabel}
              faviconPath={props.projectFaviconPath}
              projectIcon={props.projectIcon}
              className="size-3 shrink-0"
            />
          ) : null}
          <span className="min-w-0 truncate">{projectLabel}</span>
        </span>
      ) : null}

      {branchLabel ? (
        <>
          {projectLabel ? <CommandPaletteMetaDot /> : null}
          <span className="inline-flex min-w-0 items-center gap-1">
            <WorkspaceIcon variant={variant} isWorktree={isWorktree} />
            <span className="min-w-0 truncate">{branchLabel}</span>
          </span>
        </>
      ) : null}

      {showHarness && props.driverKind ? (
        <>
          {projectLabel || branchLabel ? <CommandPaletteMetaDot /> : null}
          <ProviderInstanceIcon
            driverKind={props.driverKind}
            displayName={props.providerDisplayName ?? props.driverKind}
            iconClassName="size-3 shrink-0 opacity-70"
          />
        </>
      ) : null}

      {props.isCurrent ? (
        <>
          {projectLabel || branchLabel || showHarness ? <CommandPaletteMetaDot /> : null}
          <span className="shrink-0">Current thread</span>
        </>
      ) : null}
    </span>
  );
}
