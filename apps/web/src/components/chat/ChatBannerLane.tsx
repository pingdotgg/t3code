import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { type Dispatch, type SetStateAction, useState } from "react";
import { getDefaultServerModel } from "../../providerModels";
import {
  dismissProviderStatusBannerForSession,
  providerStatusBannerItem,
} from "./ProviderStatusBanner";
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
  readonly providerStatusDismissalKey: string | null;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  readonly onOpenTerminal: () => void;
  readonly onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  readonly limitsAvailable: boolean;
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
    providerStatusDismissalKey,
    onOpenProviderSetup,
    onOpenTerminal,
    onProviderModelSelect,
    limitsAvailable,
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
  const messages = useMessages();
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
    environmentId,
    status: providerStatus,
    onDismiss: () => dismissProviderStatusBannerForSession(providerStatusDismissalKey),
    onOpenProviderSetup,
    onOpenTerminal,
    resolve: messages,
  });
  if (providerItem) items.push(providerItem);
  const errorItem = threadErrorBannerItem(
    {
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
    },
    messages,
  );
  if (errorItem) items.push(errorItem);
  if (lowLimitVisible && lowLimitSignal !== null) {
    items.push(
      lowLimitBannerItem({
        signal: lowLimitSignal,
        switchTarget: lowLimitSwitchTarget,
        onSwitch: (target) =>
          onProviderModelSelect(target.instanceId, getDefaultServerModel([target], target.driver)),
        limits:
          limitsAvailable && activeProviderStatus !== null
            ? {
                environmentId,
                instanceId: activeProviderStatus.instanceId,
                providers: providerStatuses,
                sources: usageLimitSources,
              }
            : null,
        onDismissed: () => setTrayNoticeDismissTick((tick) => tick + 1),
        resolve: messages,
      }),
    );
  }
  return items;
}
