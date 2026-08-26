import { Toast } from "@base-ui/react/toast";
import { ShellAction, type ShellNotification } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import {
  dismissToast,
  isShellMirrorableToast,
  type ThreadToastData,
  useActiveThreadRefFromRoute,
} from "../components/ui/toast";
import { hasVisibleToastAction, shouldRenderThreadScopedToast } from "../components/ui/toast.logic";

const isShellAction = Schema.is(ShellAction);

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
  const shell = window.t3Shell;
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

  useEffect(() => {
    if (!shell) return;
    void shell.publish("notifications", { items });
  }, [items, shell]);

  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        if (candidate.type === "notification.action") {
          handlersRef.current.get(candidate.id)?.actions.get(candidate.actionId)?.();
          return;
        }
        if (candidate.type === "notification.dismiss") {
          const handlers = handlersRef.current.get(candidate.id);
          dismissToast(candidate.id, handlers?.onClose);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      void shell.publish("notifications", null);
    };
  }, [shell]);

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
