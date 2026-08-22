import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  dismissOpenCode2AutoEnableNotification,
  isOpenCode2AutoEnableNotificationPending,
  openCode2AutoEnableNotificationKey,
  readOpenCode2AutoEnableNotificationState,
  recordOpenCode2AutoEnableDetection,
  resolveOpenCode2AutoEnableDetectionKey,
  writeOpenCode2AutoEnableNotificationState,
} from "../openCode2AutoEnableNotification";
import { primaryServerProvidersAtom } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import { OpenCodeIcon } from "./Icons";
import { stackedThreadToast, toastManager } from "./ui/toast";

type OpenCode2ToastId = ReturnType<typeof toastManager.add>;

export function OpenCode2AutoEnableNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const [notificationState, setNotificationState] = useState(
    readOpenCode2AutoEnableNotificationState,
  );
  const activeToastRef = useRef<{ key: string; toastId: OpenCode2ToastId } | null>(null);

  const environmentKey = useMemo(
    () =>
      primaryEnvironment === null
        ? null
        : openCode2AutoEnableNotificationKey(primaryEnvironment.environmentId),
    [primaryEnvironment],
  );
  const detectionKey = useMemo(
    () =>
      resolveOpenCode2AutoEnableDetectionKey(primaryEnvironment?.environmentId ?? null, providers),
    [primaryEnvironment, providers],
  );

  useEffect(() => {
    if (detectionKey === null) return;
    setNotificationState((current) => {
      const next = recordOpenCode2AutoEnableDetection(current, detectionKey);
      if (next !== current) writeOpenCode2AutoEnableNotificationState(next);
      return next;
    });
  }, [detectionKey]);

  const pendingKey =
    environmentKey !== null &&
    isOpenCode2AutoEnableNotificationPending(notificationState, environmentKey)
      ? environmentKey
      : null;

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast !== null && activeToast.key !== pendingKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (pendingKey === null || activeToastRef.current !== null) return;

    let toastId: OpenCode2ToastId;
    const dismiss = () => {
      if (activeToastRef.current?.toastId === toastId) activeToastRef.current = null;
      setNotificationState((current) => {
        const next = dismissOpenCode2AutoEnableNotification(current, pendingKey);
        if (next !== current) writeOpenCode2AutoEnableNotificationState(next);
        return next;
      });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Hey! We support OpenCode 2",
        description:
          "It has been automatically enabled. If you want to disable it, go to Settings.",
        timeout: 0,
        actionProps: {
          children: "Go to settings",
          onClick: () => {
            dismiss();
            toastManager.close(toastId);
            void navigate({ to: "/settings/providers" });
          },
        },
        actionVariant: "outline",
        data: {
          leadingIcon: <OpenCodeIcon aria-hidden="true" className="size-4" />,
          hideCopyButton: true,
          disableSwipe: true,
          onClose: dismiss,
        },
      }),
    );
    activeToastRef.current = { key: pendingKey, toastId };
  }, [navigate, pendingKey]);

  useEffect(
    () => () => {
      if (activeToastRef.current !== null) {
        toastManager.close(activeToastRef.current.toastId);
        activeToastRef.current = null;
      }
    },
    [],
  );

  return null;
}
