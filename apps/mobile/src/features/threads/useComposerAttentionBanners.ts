import {
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../../lib/modelOptions";
import {
  setFreshSessionPending,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { runtimeModeChoicesForSupportedModes } from "./thread-settings-options";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function buildComposerAttentionBanners(input: {
  readonly threadKey: string;
  readonly canOperateThread: boolean;
  readonly freshSessionAvailable: boolean;
  readonly freshSessionArmed: boolean;
  readonly composerError: string | null;
  readonly onDismissComposerError: () => void;
  readonly threadRuntimeMode: RuntimeMode;
  readonly draftRuntimeMode: RuntimeMode | undefined;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly policy: ManagedPolicySummary | undefined;
  readonly connectionConnected: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly modelSelection: ModelSelection;
  readonly projectId: ProjectId | null;
  readonly selectedProvider: ServerProvider | null;
  readonly onOpenModelSettings: () => void;
}): ReadonlyArray<ComposerBannerStackItem> {
  const items: ComposerBannerStackItem[] = [];

  if (input.canOperateThread) {
    const runtimeMode = input.draftRuntimeMode ?? input.threadRuntimeMode;
    const denial = managedRuntimeModeDenial(input.policy, runtimeMode);
    if (denial !== undefined) {
      const choices = runtimeModeChoicesForSupportedModes(input.supportedRuntimeModes);
      const target = clampManagedRuntimeMode(
        input.policy,
        runtimeMode,
        choices.map((choice) => choice.mode),
      );
      const targetLabel = choices.find((choice) => choice.mode === target)?.label;
      items.push({
        id: "managed-runtime-mode",
        variant: "warning",
        group: "attention",
        icon: "exclamationmark.shield",
        title: denial,
        description: "Switch this thread's mode to continue.",
        ...(target === undefined || targetLabel === undefined
          ? {}
          : {
              action: {
                label: `Switch to ${targetLabel}`,
                onPress: () =>
                  updateComposerDraftSettings(input.threadKey, { runtimeMode: target }),
              },
            }),
      });
    }
  }

  const compatibility = input.selectedProvider?.compatibilityAdvisory;
  if (
    compatibility?.message &&
    (compatibility.status === "unsupported" || compatibility.status === "broken")
  ) {
    items.push({
      id: `provider-compatibility:${input.selectedProvider?.instanceId ?? "unknown"}`,
      variant: compatibility.status === "broken" ? "error" : "warning",
      group: "attention",
      icon: "exclamationmark.triangle",
      title:
        compatibility.status === "broken"
          ? "Provider version is broken"
          : "Provider version is unsupported",
      description: compatibility.message,
      action: {
        label: "Open model settings",
        onPress: input.onOpenModelSettings,
      },
    });
  }

  if (
    input.connectionConnected &&
    isModelSelectionUnavailable(input.serverConfig, input.modelSelection, input.projectId)
  ) {
    const { title, detail } = describeUnavailableModelSelection(
      input.serverConfig,
      input.modelSelection,
      input.projectId,
    );
    items.push({
      id: "model-unavailable",
      variant: "error",
      group: "attention",
      icon: "exclamationmark.circle",
      title,
      description: detail,
      action: {
        label: "Open model settings",
        onPress: input.onOpenModelSettings,
      },
    });
  }

  if (input.composerError !== null) {
    items.push({
      id: "composer-error",
      variant: "error",
      group: "attention",
      icon: "exclamationmark.circle",
      title: input.composerError,
      onDismiss: input.onDismissComposerError,
      dismissLabel: "Dismiss error",
    });
  }

  if (input.freshSessionAvailable && input.freshSessionArmed) {
    items.push({
      id: "fresh-session",
      variant: "default",
      group: "attention",
      icon: "arrow.clockwise",
      title: "Next message starts a fresh session",
      description: "The agent won't see earlier messages in this thread.",
      onDismiss: () => setFreshSessionPending(input.threadKey, false),
      dismissLabel: "Keep the current session",
    });
  }

  return items;
}
