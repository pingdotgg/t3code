import { Toast } from "@base-ui/react/toast";
import type { ShellNotification, ShellNotificationsState } from "@t3tools/contracts/shell";
import { useMemo, useRef } from "react";

import {
  dismissToast,
  isShellMirrorableToast,
  type ThreadToastData,
  useActiveThreadRefFromRoute,
} from "../components/ui/toast";
import { hasVisibleToastAction, shouldRenderThreadScopedToast } from "../components/ui/toast.logic";
import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

type ToastHandlers = {
  readonly onClose: (() => void) | undefined;
  readonly actions: ReadonlyMap<string, () => void>;
};

/**
 * Mounted inside ToastProvider when the Qt shell hosts the app. Mirrors the
 * stacked toast list (adds, updates, closes, expiry) as `notifications` and
 * runs a toast's buttons or dismissal when the shell asks. Toasts whose body
 * is a React element stay in the page's own viewport.
 */
export function ShellToastBridge() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();

  const handlersRef = useRef(new Map<string, ToastHandlers>());
  const items = useMemo((): ReadonlyArray<ShellNotification> => {
    const handlers = new Map<string, ToastHandlers>();
    const result: ShellNotification[] = [];
    for (const toast of toasts) {
      if (
        !shouldRenderThreadScopedToast(toast.data, activeThreadRef) ||
        !isShellMirrorableToast(toast)
      ) {
        continue;
      }
      const actions = new Map<string, () => void>();
      const actionList: Array<ShellNotification["actions"][number]> = [];
      const invoke = (onClick: ((event: never) => void) | undefined) => () => {
        onClick?.({ preventDefault() {}, stopPropagation() {} } as never);
      };
      for (const extra of toast.data?.additionalActions ?? []) {
        if (typeof extra.props.children !== "string") continue;
        actions.set(extra.id, invoke(extra.props.onClick as never));
        actionList.push({ id: extra.id, label: extra.props.children, primary: false });
      }
      const secondary = toast.data?.secondaryActionProps;
      if (secondary && typeof secondary.children === "string") {
        actions.set("secondary", invoke(secondary.onClick as never));
        actionList.push({ id: "secondary", label: secondary.children, primary: false });
      }
      const primary = toast.actionProps;
      if (hasVisibleToastAction(primary) && typeof primary?.children === "string") {
        actions.set("primary", invoke(primary.onClick as never));
        actionList.push({ id: "primary", label: primary.children, primary: true });
      }
      handlers.set(toast.id, { onClose: toast.data?.onClose, actions });
      result.push({
        id: toast.id,
        type: resolveType(toast.type),
        title: typeof toast.title === "string" ? toast.title : "",
        description: typeof toast.description === "string" ? toast.description : null,
        updateKey: toast.updateKey ?? 0,
        actions: actionList,
      });
    }
    handlersRef.current = handlers;
    return result;
  }, [activeThreadRef, toasts]);

  const state = useMemo((): ShellNotificationsState => ({ items }), [items]);
  useShellPublish("notifications", state);

  useShellActions((action) => {
    if (action.type === "notification.action") {
      handlersRef.current.get(action.id)?.actions.get(action.actionId)?.();
      return;
    }
    if (action.type === "notification.dismiss") {
      const handlers = handlersRef.current.get(action.id);
      dismissToast(action.id, handlers?.onClose);
    }
  });

  return null;
}

function resolveType(type: string | undefined): ShellNotification["type"] {
  switch (type) {
    case "error":
    case "loading":
    case "success":
    case "warning":
      return type;
    default:
      return "info";
  }
}
