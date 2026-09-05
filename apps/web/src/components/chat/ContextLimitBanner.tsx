import { CircleAlertIcon, SettingsIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

interface ContextLimitBannerInput {
  readonly threadId: string;
  readonly tokenLimit: number;
  readonly canChangeTokenLimit: boolean;
  readonly supportsGeneration: boolean;
  readonly isGeneratingHandover: boolean;
  readonly hasSavedHandover: boolean;
  readonly onChangeTokenLimit: () => void;
  readonly onGenerateHandover: () => void;
}

export function buildContextLimitBannerItem({
  threadId,
  tokenLimit,
  canChangeTokenLimit,
  supportsGeneration,
  isGeneratingHandover,
  hasSavedHandover,
  onChangeTokenLimit,
  onGenerateHandover,
}: ContextLimitBannerInput): ComposerBannerStackItem {
  return {
    id: `context-limit:${threadId}`,
    variant: "info",
    priority: "urgent",
    icon: <CircleAlertIcon />,
    title: (
      <span className="flex min-w-0 items-center gap-1">
        <span>This thread has reached {tokenLimit.toLocaleString("en-US")} tokens</span>
        {canChangeTokenLimit ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Change thread token limit"
            onClick={onChangeTokenLimit}
          >
            <SettingsIcon className="size-3.5" />
            <span className="sr-only">Change thread token limit</span>
          </Button>
        ) : null}
      </span>
    ),
    description: hasSavedHandover
      ? "Your saved handover is ready. Open it in a new draft to review it before choosing the next model and reasoning level."
      : supportsGeneration
        ? "T3 will not start another turn here. Create a compact handover, then review it in a new draft before choosing the next model and reasoning level."
        : "T3 will not start another turn here. Update the connected server to create an automatic handover, or start a new thread manually.",
    actions:
      supportsGeneration || hasSavedHandover ? (
        <Button
          size="xs"
          variant="outline"
          disabled={isGeneratingHandover}
          onClick={onGenerateHandover}
        >
          {isGeneratingHandover
            ? "Creating handover..."
            : hasSavedHandover
              ? "Open saved handover"
              : "Handover to new thread"}
        </Button>
      ) : undefined,
  };
}
