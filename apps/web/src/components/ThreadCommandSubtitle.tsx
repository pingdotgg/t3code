import type { ProviderDriverKind } from "@t3tools/contracts";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type ThreadCommandSubtitleVariant =
  | "favicon-workspace-harness"
  | "favicon-workspace"
  | "favicon-branch-harness";

export const COMMAND_PALETTE_META_ICON_CLASS = "size-3 shrink-0 text-muted-foreground/70";

export function ThreadCommandSubtitle(props: {
  project: ProjectFaviconProject | null;
  projectTitle: string | null;
  environmentLabel?: string | null;
  branch: string | null;
  worktreePath: string | null;
  isCurrent: boolean;
  driverKind?: ProviderDriverKind | null;
  providerDisplayName?: string | null;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  variant?: ThreadCommandSubtitleVariant;
  className?: string;
}) {
  const label = props.projectTitle?.trim() || props.branch?.trim() || "Thread";
  const details = [
    props.environmentLabel,
    props.branch,
    props.providerDisplayName,
    props.isCurrent ? "Current thread" : null,
  ].filter((part) => part && part !== label);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1 text-meta text-muted-foreground",
              props.className,
            )}
          />
        }
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-3 shrink-0" />
        ) : null}
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="block">{label}</span>
        {details.map((part) => (
          <span className="block" key={part}>
            {part}
          </span>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}
