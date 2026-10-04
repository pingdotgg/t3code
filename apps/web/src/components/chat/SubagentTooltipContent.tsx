import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItemStatus,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";

/** Geometry and preview limits stay identical in lineage and timeline tooltips. */
export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  provider?: ServerProvider | undefined;
  /** The environment's instances; with several accounts on one provider, the card names this one. */
  providers?: ReadonlyArray<ServerProvider> | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?: Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath"> | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: OrchestrationV2TurnItemStatus;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const { modelLabel, workspace: metadata } = resolveSubagentMetadata(props);
  const preview = subagentDetailPreview(props);
  const driver = props.provider?.driver ?? props.driver;
  const entries = deriveProviderInstanceEntries(props.providers ?? []);
  const entry = entries.find((candidate) => candidate.instanceId === props.provider?.instanceId);
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  const working = ["running", "in_progress", "pending", "waiting"].includes(props.status);
  const failed = ["failed", "error"].includes(props.status);
  const StatusIcon = working
    ? CircleDashedIcon
    : failed
      ? CircleXIcon
      : props.status === "completed"
        ? CheckIcon
        : CircleDashedIcon;
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center gap-2">
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={entry?.displayName ?? props.provider?.displayName ?? driver}
            accentColor={entry?.accentColor}
            acpRegistryIconUrl={props.provider?.iconUrl}
            // Same treatment as the sidebar card: accent dot, account in the label.
            showBadge={showInstanceBadge && entry?.accentColor !== undefined}
            badgeContent="none"
            badgeClassName="h-2 min-w-2 px-0"
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate text-foreground/75">
          {showInstanceBadge ? `${modelLabel} · ${entry.displayName}` : modelLabel}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm font-medium capitalize",
            working
              ? "text-info"
              : failed
                ? "text-error"
                : props.status === "completed"
                  ? "text-success"
                  : "text-muted-foreground",
          )}
        >
          <StatusIcon aria-hidden className="size-3 shrink-0" />
          {props.status.replaceAll("_", " ")}
        </span>
        {props.elapsed}
      </div>
      {metadata.map(({ label, value }) => {
        const Icon = label === "Branch" ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex" showTitle={false} />
          </div>
        );
      })}
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex" showTitle={false} />
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
