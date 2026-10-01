/**
 * Toast delivery for mutations, shared by the repository view and the
 * pull-request panel.
 */
import { uiNotificationsApi, type VcsActionKind } from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useRef, useState } from "react";

import {
  MUTATION_TOAST_DISMISS_MS,
  dismissReceiptAfterSeen,
  isNotificationDismissal,
  mutationToastSettle,
  mutationToastStart,
  postFollowUpReceipt,
  type MutationFollowUp,
} from "./viewModel.js";

/**
 * `t3.ui/notifications` consumer. Native repository mutations report through
 * toast progress (GitActionsControl): a loading toast on start, the same
 * notification updated to success or error on settle — never an inline row.
 * The grant-free `getCapabilities` probe names a provider-less host before
 * any write; a `notify` failure latches the adapter off (a denied grant
 * never recovers within a session). Every delivery loss — rejected `notify`,
 * rejected or unapplied `update` — hands that mutation's receipt back to the
 * inline row through `onReceiptLost`, and a `notification-expired` update
 * (a user-dismissed loading toast) does so without killing the adapter.
 * A success with a follow-up (native's toast CTA) posts a fresh receipt
 * carrying the button instead, since `update` cannot add actions.
 */
export interface MutationToast {
  readonly settle: (
    result: { readonly ok: boolean; readonly detail: string },
    followUp?: MutationFollowUp | null,
  ) => void;
  /** Settles with a caller-worded outcome (native's own toast words). */
  readonly settleWith: (patch: MutationToastPatch) => void;
}

/** A settled toast in the caller's words; success dismisses itself once seen. */
export interface MutationToastPatch {
  readonly severity: "success" | "warning" | "error";
  readonly title: string;
  readonly body?: string;
}

export function useMutationToasts(
  host: ClientHost,
  session: ViewSession,
  enabled: boolean,
  runFollowUp: (action: VcsActionKind) => void = () => {},
): {
  /** Posts the loading toast, or null when toasts are unavailable (report inline). */
  readonly begin: (
    label: string,
    onReceiptLost: () => void,
    startTitle?: string,
  ) => MutationToast | null;
  /**
   * Posts one settled toast with no loading toast before it — native's
   * result-only receipts. False when toasts are unavailable (report inline);
   * a later delivery loss hands the receipt back through `onReceiptLost`.
   */
  readonly report: (patch: MutationToastPatch, onReceiptLost: () => void) => boolean;
} {
  const [toastsLive, setToastsLive] = useState(false);
  const [followUpsLive, setFollowUpsLive] = useState(false);
  const dead = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(uiNotificationsApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (capabilities) => {
          // A latched-dead adapter stays dead across re-probes — a denied
          // grant never recovers within a session.
          if (!signal.aborted && !dead.current) {
            setToastsLive(
              capabilities.operations.notify === true && capabilities.operations.update === true,
            );
            setFollowUpsLive(capabilities.operations.awaitAction === true);
          }
        },
        () => {},
      );
    return () => controller.abort();
  }, [host, session, enabled]);

  const markDead = () => {
    if (dead.current || session.signal.aborted) return;
    dead.current = true;
    setToastsLive(false);
  };

  // A thread-anchored toast paints only while its thread is active — the
  // native threadToastData behavior. Targeting fields may only name this
  // context's own scope.
  const resource = session.context.resource;
  const target = {
    ...(resource.threadId !== undefined
      ? { anchor: "thread" as const, threadId: resource.threadId }
      : {}),
    ...(resource.projectId !== undefined ? { projectId: resource.projectId } : {}),
  };
  // The contract's `update` carries no duration, so success receipts are
  // dismissed on a timer — but an unseen receipt must not expire.
  // dismissReceiptAfterSeen mirrors native's dismissAfterVisibleMs: the
  // clock runs only while the receipt can be read — the view is shown
  // and the document is visible and focused. DOM globals are absent only
  // where nothing can paint, so the view's own visibility decides there.
  const receiptSeen = {
    signal: session.signal,
    seen: () =>
      session.visible &&
      (typeof document === "undefined" ||
        typeof window === "undefined" ||
        (document.visibilityState === "visible" && document.hasFocus())),
    onChange: (listener: () => void) => {
      const offView = session.onVisibility(listener);
      if (typeof document === "undefined" || typeof window === "undefined") return offView;
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("focus", listener);
      window.addEventListener("blur", listener);
      return () => {
        offView();
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("focus", listener);
        window.removeEventListener("blur", listener);
      };
    },
  };
  const dismiss = (notificationId: string) => {
    void bindApi(uiNotificationsApi, host, session.context)
      .invoke("dismiss", { notificationId }, session.signal)
      .catch(() => {});
  };

  const report = (patch: MutationToastPatch, onReceiptLost: () => void): boolean => {
    if (!toastsLive || dead.current) return false;
    void bindApi(uiNotificationsApi, host, session.context)
      .invoke("notify", { ...patch, ...target }, session.signal)
      .then(
        ({ notificationId }) => {
          if (dead.current) {
            dismiss(notificationId);
            onReceiptLost();
            return;
          }
          if (patch.severity === "success")
            dismissReceiptAfterSeen(receiptSeen, MUTATION_TOAST_DISMISS_MS, () =>
              dismiss(notificationId),
            );
        },
        () => {
          markDead();
          onReceiptLost();
        },
      );
    return true;
  };

  const begin = (
    label: string,
    onReceiptLost: () => void,
    startTitle?: string,
  ): MutationToast | null => {
    if (!toastsLive || dead.current) return null;
    const api = bindApi(uiNotificationsApi, host, session.context);
    // The follow-up receipt awaits its loading-toast retraction so a failed
    // dismiss falls back to the in-place update; everything else is
    // fire-and-forget.
    const dismissOrReject = (notificationId: string): Promise<void> =>
      api.invoke("dismiss", { notificationId }, session.signal).then(() => {});
    const posted = api
      .invoke(
        "notify",
        {
          ...mutationToastStart(label),
          ...(startTitle !== undefined ? { title: startTitle } : {}),
          ...target,
        },
        session.signal,
      )
      .then(
        (result) => {
          // A resolution landing after the adapter died posts a loading
          // toast nothing will update — retract it on arrival.
          if (dead.current) dismiss(result.notificationId);
          return result.notificationId;
        },
        () => {
          markDead();
          onReceiptLost();
          return null;
        },
      );
    const settleInPlace = (notificationId: string, patch: MutationToastPatch) =>
      void api.invoke("update", { notificationId, ...patch }, session.signal).then(
        ({ applied }) => {
          if (!applied) {
            // The notification never took the patch — the outcome
            // returns to the inline row so it is not silently lost.
            onReceiptLost();
            return;
          }
          if (patch.severity === "success")
            dismissReceiptAfterSeen(receiptSeen, MUTATION_TOAST_DISMISS_MS, () =>
              dismiss(notificationId),
            );
        },
        (error) => {
          onReceiptLost();
          // A dismissed toast reports notification-expired — the
          // provider still works, only this receipt goes inline. Any
          // other rejection is delivery loss and latches the adapter.
          if (!isNotificationDismissal(error)) markDead();
        },
      );
    return {
      settle(result, followUp) {
        void posted.then(async (notificationId) => {
          if (notificationId === null) return;
          if (dead.current) {
            // The adapter died after this toast posted — retract the
            // orphaned loading toast and hand the receipt to the row.
            onReceiptLost();
            dismiss(notificationId);
            return;
          }
          // Native's success toast carries its CTA (Push after a commit).
          if (result.ok && followUp && followUpsLive) {
            const replaced = await postFollowUpReceipt(
              {
                notify: (input) => api.invoke("notify", { ...input, ...target }, session.signal),
                dismiss: dismissOrReject,
                awaitAction: (id) =>
                  api.invoke("awaitAction", { notificationId: id }, session.signal),
              },
              notificationId,
              result.detail,
              followUp,
              {
                onPosted: (receiptId) =>
                  dismissReceiptAfterSeen(receiptSeen, MUTATION_TOAST_DISMISS_MS, () =>
                    dismiss(receiptId),
                  ),
                run: runFollowUp,
              },
            );
            if (replaced) return;
          }
          settleInPlace(notificationId, mutationToastSettle(label, result));
        });
      },
      settleWith(patch) {
        void posted.then((notificationId) => {
          if (notificationId === null) return;
          if (dead.current) {
            onReceiptLost();
            dismiss(notificationId);
            return;
          }
          settleInPlace(notificationId, patch);
        });
      },
    };
  };
  return { begin, report };
}
