import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstFailedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  providerUpdateNotificationKey,
  shouldShowPrimaryProviderUpdateToast,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast =
  | { readonly kind: "prompt"; readonly key: string; readonly toastId: ProviderUpdateToastId }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerCount: number;
    };

function ProviderUpdateToastIcon({ provider }: { provider: ProviderDriverKind }) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  if (!ProviderIcon) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <DownloadIcon aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderIcon aria-hidden="true" className="size-4" />
      <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon aria-hidden="true" className="size-2.5 text-success" strokeWidth={2.5} />
      </span>
    </span>
  );
}

function addProviderUpdateToast(input: {
  readonly view: ProviderUpdateToastView;
  readonly openSettings: (toastId: ProviderUpdateToastId) => void;
}) {
  if (input.view.type === "loading" || input.view.type === "success") {
    return toastManager.add({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: hiddenToastActionProps,
      data: {
        hideCopyButton: true,
        ...(input.view.dismissAfterVisibleMs !== undefined
          ? { dismissAfterVisibleMs: input.view.dismissAfterVisibleMs }
          : {}),
      },
    });
  }

  let toastId!: ProviderUpdateToastId;
  toastId = toastManager.add(
    stackedThreadToast({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: {
        children: "Settings",
        onClick: () => input.openSettings(toastId),
      },
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
      },
    }),
  );
  return toastId;
}

/**
 * The single-prompt provider update notification used when there is only one
 * local environment (no WSL backend). Non-WSL users see exactly this flow — the
 * per-environment split is gated behind WSL presence.
 */
export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  // If this flow unmounts (e.g. a WSL backend appears and we switch to the
  // per-environment popover), close any prompt it owns so it does not linger.
  useEffect(() => {
    return () => {
      const activeToast = activeToastRef.current;
      if (activeToast?.kind === "prompt") {
        toastManager.close(activeToast.toastId);
      }
      activeToastRef.current = null;
    };
  }, []);

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(
    (toastId?: ProviderUpdateToastId) => {
      const activeToast = activeToastRef.current;
      if (toastId !== undefined) {
        toastManager.close(toastId);
      } else if (activeToast?.kind === "prompt") {
        toastManager.close(activeToast.toastId);
      }
      if (
        activeToast &&
        (toastId === undefined ||
          (activeToast.kind === "prompt" && activeToast.toastId === toastId))
      ) {
        activeToastRef.current = null;
      }
      void navigate({ to: "/settings/providers" });
    },
    [navigate],
  );

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeToast.providerInstanceIds.has(provider.instanceId),
    );
    const view = getProviderUpdateProgressToastView({
      providers: activeProviders,
      providerCount: activeToast.providerCount,
    });
    if (!shouldShowPrimaryProviderUpdateToast(view)) {
      return;
    }

    addProviderUpdateToast({ view, openSettings: openProviderSettings });
    activeToastRef.current = null;
  }, [providers, openProviderSettings]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      !notificationKey ||
      dismissedNotificationKeys.has(notificationKey) ||
      seenProviderUpdateNotificationKeys.has(notificationKey) ||
      activeToastRef.current
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

    let toastId!: ProviderUpdateToastId;
    let updateStarted = false;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      dismissNotificationKey(notificationKey);
    };

    const runUpdates = () => {
      if (updateStarted || oneClickProviders.length === 0 || !primaryEnvironment) {
        return;
      }
      updateStarted = true;

      const providerCount = oneClickProviders.length;
      const providerInstanceIds = new Set(oneClickProviders.map((provider) => provider.instanceId));
      const activeUpdate: ActiveProviderUpdateToast = {
        kind: "update",
        key: notificationKey,
        providerInstanceIds,
        providerCount,
      };
      activeToastRef.current = activeUpdate;

      toastManager.close(toastId);

      void (async () => {
        const results = [];
        for (const provider of oneClickProviders) {
          results.push(
            await updateProvider({
              environmentId: primaryEnvironment.environmentId,
              input: {
                provider: provider.driver,
                instanceId: provider.instanceId,
              },
            }),
          );
        }

        const activeUpdateToast = activeToastRef.current;
        if (activeUpdateToast !== activeUpdate) {
          return;
        }

        const failedMessage = firstFailedProviderUpdateMessage(results);
        if (failedMessage) {
          addProviderUpdateToast({
            view: getProviderUpdateRejectedToastView(providerCount, failedMessage),
            openSettings: openProviderSettings,
          });
          activeToastRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = getProviderUpdateProgressToastView({
          providers: updatedProviderSnapshots,
          providerCount,
        });
        if (shouldShowPrimaryProviderUpdateToast(view)) {
          addProviderUpdateToast({ view, openSettings: openProviderSettings });
          activeToastRef.current = null;
        }
      })();
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: initialView.type,
        title: initialView.title,
        description: initialView.description,
        timeout: 0,
        actionProps:
          oneClickProviders.length > 0
            ? {
                children: "Update",
                onClick: runUpdates,
              }
            : {
                children: "Settings",
                onClick: openSettings,
              },
        actionVariant: "outline",
        data: {
          leadingIcon:
            updateProviders.length === 1 ? (
              <ProviderUpdateToastIcon provider={updateProviders[0]!.driver} />
            ) : undefined,
          hideCopyButton: true,
          onClose: dismissPrompt,
          ...(oneClickProviders.length > 0
            ? {
                secondaryActionProps: {
                  children: "Settings",
                  onClick: openSettings,
                },
                secondaryActionVariant: "outline" as const,
              }
            : {}),
        },
      }),
    );
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    updateProvider,
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    primaryEnvironment,
    updateProviders,
  ]);

  return null;
}
