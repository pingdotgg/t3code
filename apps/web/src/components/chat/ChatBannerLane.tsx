import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusBannerKey: string | null;
  setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
  /** Offered while the shown error is the one a file restore stopped with. */
  fileRestoreRetryMessage: string | null;
  onRetryFileRestore: () => void;
  onClearFileRestoreRetry: () => void;
}) {
  const {
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
    fileRestoreRetryMessage,
    onRetryFileRestore,
    onClearFileRestoreRetry,
  } = props;
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      <ThreadErrorBanner
        error={threadError}
        errorClass={threadErrorClass}
        errorCode={threadErrorCode}
        action={
          fileRestoreRetryMessage !== null && fileRestoreRetryMessage === threadError
            ? { label: "Try again", onClick: onRetryFileRestore }
            : null
        }
        onDismiss={() => {
          setThreadError(threadId, null);
          onClearFileRestoreRetry();
          dismissThreadErrorBannerForSession(threadErrorBannerKey);
          setThreadErrorBannerDismissTick((tick) => tick + 1);
        }}
      />
    </div>
  );
}
