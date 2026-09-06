import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

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
 *
 * Progress comes only from the environment's published `updateState`: the
 * backend marks a target queued the moment it accepts the dispatch and refuses a
 * second one for the same instance, so there is nothing for optimistic client
 * state to cover.
 */
export function useComposerProviderUpdateBannerItem(
  environmentId: EnvironmentId | null,
): ComposerBannerStackItem | null {
  const environment = useEnvironment(environmentId);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);

  const environmentLabel = environment?.label;
  const target = environment?.entry.target;
  // Providers survive a disconnect, so offering an update we cannot dispatch
  // needs the live phase to rule it out.
  const isConnected = environment?.connection.phase === "connected";
  const providers = environment?.serverConfig?.providers;

  return useMemo(() => {
    if (
      environmentId === null ||
      environmentLabel === undefined ||
      target === undefined ||
      isLocalConnectionTarget(target) ||
      !isConnected
    ) {
      return null;
    }
    const notice = buildRemoteProviderUpdateNotice({
      environmentId,
      environmentLabel,
      providers: providers ?? [],
      dismissedKeys: dismissedNotificationKeys,
    });
    if (notice === null) {
      return null;
    }
    const { status } = notice;
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
          onClick={() => {
            for (const candidate of notice.candidates) {
              void updateProvider({
                environmentId,
                input: { provider: candidate.driver, instanceId: candidate.instanceId },
              });
            }
          }}
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
  }, [
    dismissNotificationKey,
    dismissedNotificationKeys,
    environmentId,
    environmentLabel,
    isConnected,
    providers,
    target,
    updateProvider,
  ]);
}
