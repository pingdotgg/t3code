import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItemStatus,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { getModelSelectionStringOptionValue, resolveSelectableModel } from "@t3tools/shared/model";
import { getTraitsSpeedDisplay, TraitsSpeedIcon } from "./TraitsSpeed";
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

/** Geometry and preview limits stay identical in lineage and timeline tooltips. */
export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  providerInstanceId: ProviderInstanceId;
  origin: OrchestrationV2Subagent["origin"];
  provider?: ServerProvider | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath" | "modelSelection">
    | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: OrchestrationV2TurnItemStatus;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const { modelLabel, workspace: metadata } = resolveSubagentMetadata(props);
  const preview = subagentDetailPreview(props);
  const model = props.model?.trim();
  const modelSlug = props.provider
    ? resolveSelectableModel(props.provider.driver, model, props.provider.models)
    : model;
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const childSelection = props.childThread?.modelSelection;
  const childModel = props.provider
    ? (resolveSelectableModel(
        props.provider.driver,
        childSelection?.model,
        props.provider.models,
      ) ?? childSelection?.model.trim())
    : childSelection?.model.trim();
  const provider = props.provider;
  const matchingSelection =
    props.origin === "app_owned" &&
    childModel === (modelSlug ?? model) &&
    childSelection?.instanceId === props.providerInstanceId
      ? childSelection
      : undefined;
  const effort = ["reasoningEffort", "effort", "reasoning", "variant"]
    .map((id) => getModelSelectionStringOptionValue(matchingSelection, id))
    .find(Boolean);
  const speed = provider
    ? providerModel?.capabilities?.optionDescriptors
        ?.map((descriptor) => {
          const saved = matchingSelection?.options?.find((option) => option.id === descriptor.id);
          if (
            descriptor.id === "fastMode" &&
            descriptor.type === "boolean" &&
            typeof saved?.value === "boolean"
          ) {
            return getTraitsSpeedDisplay(provider.driver, {
              ...descriptor,
              currentValue: saved.value,
            });
          }
          if (
            provider.driver === "codex" &&
            descriptor.id === "serviceTier" &&
            descriptor.type === "select" &&
            typeof saved?.value === "string" &&
            descriptor.options.some((option) => option.id === saved.value)
          ) {
            return getTraitsSpeedDisplay(provider.driver, {
              ...descriptor,
              currentValue: saved.value,
            });
          }
          return null;
        })
        .find(Boolean)
    : undefined;
  const driver = props.provider?.driver ?? props.driver;
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
            displayName={props.provider?.displayName ?? driver}
            acpRegistryIconUrl={props.provider?.iconUrl}
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 text-foreground/75">
          <span className="min-w-0 truncate">{modelLabel}</span>
          {effort || speed?.speedIcon ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              {effort ? " · " : null}
              {speed?.speedIcon && provider ? (
                <TraitsSpeedIcon provider={provider.driver} speedIcon={speed.speedIcon} size="xs" />
              ) : null}
              {effort}
            </span>
          ) : null}
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
