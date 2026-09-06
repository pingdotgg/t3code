import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";

import { useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useDismissedProviderUpdateNotificationKeys } from "../../providerUpdateDismissal";
import { isLocalConnectionTarget } from "../ProviderUpdateLaunchNotification.environments";
import { buildRemoteProviderUpdateNotice } from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerServerUpdateIcon } from "./ComposerServerUpdateStatus";

/**
 * The provider update notice for a remote environment (SSH, relay, T3 Connect).
 * Local environments already get the one-click update from the launch popover,
 * so they are skipped here and never double-notified.
 */
export function useComposerProviderUpdateBannerItem(
  environmentId: EnvironmentId | null,
): ComposerBannerStackItem | null {
  const environment = useEnvironment(environmentId);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // A state update may land after runUpdate returns, so it cannot gate the
  // dispatch — a ref updates synchronously and blocks a double-click.
  const inFlightKeyRef = useRef<string | null>(null);

  const environmentLabel = environment?.label;
  const target = environment?.entry.target;
  const connectionPhase = environment?.connection.phase;
  const providers = environment?.serverConfig?.providers;

  const notice = useMemo(
    () =>
      environmentId === null ||
      environmentLabel === undefined ||
      target === undefined ||
      isLocalConnectionTarget(target) ||
      connectionPhase !== "connected"
        ? null
        : buildRemoteProviderUpdateNotice({
            environmentId,
            environmentLabel,
            providers: providers ?? [],
            dismissedKeys: dismissedNotificationKeys,
          }),
    [
      connectionPhase,
      dismissedNotificationKeys,
      environmentId,
      environmentLabel,
      providers,
      target,
    ],
  );

  return useMemo(() => {
    if (environmentId === null || notice === null) {
      return null;
    }
    const status = pendingKey === notice.dismissalKey ? "running" : notice.status;
    const runUpdate = async () => {
      if (inFlightKeyRef.current === notice.dismissalKey) {
        return;
      }
      inFlightKeyRef.current = notice.dismissalKey;
      setPendingKey(notice.dismissalKey);
      try {
        await Promise.allSettled(
          notice.targets.map((target) =>
            updateProvider({
              environmentId,
              input: { provider: target.driver, instanceId: target.instanceId },
            }),
          ),
        );
      } finally {
        inFlightKeyRef.current = null;
        setPendingKey(null);
      }
    };
    return {
      id: `provider-update:${environmentId}`,
      variant: status === "failed" ? "error" : "default",
      // Match the server notice: progress outranks passive notices.
      priority: status === "running" ? "urgent" : "notice",
      icon: <ComposerServerUpdateIcon status={status} />,
      title: notice.title,
      description: notice.failureMessage ?? undefined,
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={status === "running"}
          onClick={() => void runUpdate()}
        >
          {status === "running" ? "Updating…" : status === "failed" ? "Retry" : "Update now"}
        </Button>
      ),
      ...(status === "running"
        ? {}
        : {
            dismissLabel: "Dismiss provider update notice",
            onDismiss: () => dismissNotificationKey(notice.dismissalKey),
          }),
    };
  }, [dismissNotificationKey, environmentId, notice, pendingKey]);
}
