import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { type Dispatch, type SetStateAction, useState } from "react";
import { getDefaultServerModel } from "../../providerModels";
import { providerStatusBannerItem } from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, threadErrorBannerItem } from "./ThreadErrorBanner";
import {
  isLowLimitDismissed,
  lowLimitBannerItem,
  resolveLowLimitSignal,
  resolveLowLimitSwitchTarget,
} from "./ComposerUsageLimits";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Provider, run-error, and limit notices share the composer's tray status line. */
export function useChatBannerLane(input: {
  readonly environmentId: EnvironmentId;
  readonly activeProviderStatus: ServerProvider | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly canSwitchProvider: boolean;
  readonly providerStatus: ServerProvider | null;
  readonly providerStatusBannerKey: string | null;
  readonly setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  readonly onOpenTerminal: () => void;
  readonly onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  readonly onShowLimits: (() => void) | null;
  readonly threadId: ThreadId | null;
  readonly threadError: string | null;
  readonly threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  readonly threadErrorCode: string | null;
  readonly threadErrorBannerKey: string | null;
  readonly onRetry: (() => void) | null;
  readonly retrying: boolean;
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  readonly setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    environmentId,
    activeProviderStatus,
    providerStatuses,
    usageLimitSources,
    canSwitchProvider,
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
    onOpenTerminal,
    onProviderModelSelect,
    onShowLimits,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    onRetry,
    retrying,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = input;
  const [, setTrayNoticeDismissTick] = useState(0);
  const lowLimitSignal = resolveLowLimitSignal(
    activeProviderStatus,
    providerStatuses,
    usageLimitSources,
    environmentId,
  );
  const lowLimitVisible = lowLimitSignal !== null && !isLowLimitDismissed(lowLimitSignal.key);
  const lowLimitSwitchTarget =
    lowLimitVisible && activeProviderStatus !== null && canSwitchProvider
      ? resolveLowLimitSwitchTarget(activeProviderStatus, providerStatuses)
      : null;
  const items: ComposerBannerStackItem[] = [];
  const providerItem = providerStatusBannerItem({
    status: providerStatus,
    onDismiss: () => setDismissedProviderStatusBannerKey(providerStatusBannerKey),
    onOpenProviderSetup,
    onOpenTerminal,
  });
  if (providerItem) items.push(providerItem);
  const errorItem = threadErrorBannerItem({
    bannerKey: threadErrorBannerKey,
    error: threadError,
    errorClass: threadErrorClass,
    errorCode: threadErrorCode,
    onRetry,
    retrying,
    onDismiss: () => {
      if (threadId !== null) setThreadError(threadId, null);
      dismissThreadErrorBannerForSession(threadErrorBannerKey);
      setThreadErrorBannerDismissTick((tick) => tick + 1);
    },
  });
  if (errorItem) items.push(errorItem);
  if (lowLimitVisible && lowLimitSignal !== null) {
    items.push(
      lowLimitBannerItem({
        signal: lowLimitSignal,
        switchTarget: lowLimitSwitchTarget,
        onSwitch: (target) =>
          onProviderModelSelect(target.instanceId, getDefaultServerModel([target], target.driver)),
        onShowLimits,
        onDismissed: () => setTrayNoticeDismissTick((tick) => tick + 1),
      }),
    );
  }
  return items;
}
