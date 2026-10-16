import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "~/hooks/useSettings";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";

import { toastManager } from "../../ui/toast";
import { readPullRequestListPreferences } from "../pullRequestListPreferences";
import { useGuideRunStore, type GuideRunWatch } from "./guideRunStore";

const RUN_POLL_MS = 5_000;
const UNSEEN_RUN_MS = 60_000;

export function PullRequestGuideRunCoordinator() {
  const watches = useGuideRunStore((state) => state.watches);
  return Object.entries(watches).map(([key, watch]) => (
    <GuideRunWatcher key={key} runKey={key} watch={watch} />
  ));
}

function GuideRunWatcher({ runKey, watch }: { runKey: string; watch: GuideRunWatch }) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.reviewGuide({
      environmentId: watch.environmentId,
      input: watch.reference,
    }),
  );
  const navigate = useNavigate();
  const refresh = query.refresh;
  useEffect(() => {
    const timer = setInterval(refresh, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const data = query.data;
  const sawRunning = useRef(false);
  useEffect(() => {
    if (data === null) return;
    if (data.run?._tag === "Running") {
      sawRunning.current = true;
      return;
    }
    const failure =
      data.run?._tag === "Failed" && data.run.failedAt !== watch.previousFailedAt
        ? data.run.detail
        : null;
    const written =
      failure === null && data.guide !== null && data.guide.generatedAt !== watch.previousGuideAt;
    if (failure === null && !written) {
      if (sawRunning.current || Date.now() - watch.since > UNSEEN_RUN_MS) {
        useGuideRunStore.getState().settle(runKey);
      }
      return;
    }
    const store = useGuideRunStore.getState();
    store.settle(runKey);
    const looking = document.visibilityState === "visible" && document.hasFocus();
    if (looking && store.shownKey === runKey) return;

    const title = failure === null ? "Review guide ready" : "Review guide failed";
    const body = watch.title ?? `${watch.reference.repository} #${watch.reference.number}`;
    const open = () => {
      useGuideRunStore.getState().requestOpen(runKey);
      void navigate({
        to: "/pull-requests",
        search: {
          ...readPullRequestListPreferences(),
          repository: watch.reference.repository,
          number: watch.reference.number,
          selectedProjectId: watch.reference.projectId,
          selectedEnvironmentId: watch.environmentId,
          ...(watch.reference.host === undefined ? {} : { selectedHost: watch.reference.host }),
        },
      });
    };
    const mode = getClientSettings().notificationMode;
    if (hasNotificationSound(mode)) {
      void playNotificationSound(failure === null ? "completion" : "input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (looking) {
      const toastId = toastManager.add({
        type: failure === null ? "success" : "error",
        title,
        description: failure === null ? body : `${body}: ${failure}`,
        data: {
          hideCopyButton: true,
          leadingIcon:
            failure === null ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ),
        },
        actionProps: {
          children: "Open guide",
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, { body, tag: `guide:${runKey}`, silent: true });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  }, [data, navigate, runKey, watch]);

  return null;
}
