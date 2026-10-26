import type { AnyRouter } from "@tanstack/react-router";
import type { PullRequestReviewGuideResult } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { getClientSettings } from "~/hooks/useSettings";
import { observedPullRequestTitle, pullRequestEnvironment } from "~/state/pullRequests";
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

// The detail panel marks the guide tab it has on screen.
function isGuideShown(runKey: string): boolean {
  return document.querySelector(`[data-guide-shown="${CSS.escape(runKey)}"]`) !== null;
}

/** Polls every watched guide run and announces each one when it settles. App-lifetime. */
export function startGuideRunNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const running = new Map<string, () => void>();
  const sync = (watches: Readonly<Record<string, GuideRunWatch>>) => {
    for (const [key, stop] of running) {
      if (watches[key] !== undefined) continue;
      running.delete(key);
      stop();
    }
    for (const [key, watch] of Object.entries(watches)) {
      if (running.has(key)) continue;
      const stop = watchGuideRun(registry, router, key, watch);
      // The first read can settle the run before it is recorded as running.
      if (useGuideRunStore.getState().watches[key] === watch) running.set(key, stop);
      else stop();
    }
  };
  sync(useGuideRunStore.getState().watches);
  const unsubscribe = useGuideRunStore.subscribe((state, previous) => {
    if (state.watches !== previous.watches) sync(state.watches);
  });
  return () => {
    unsubscribe();
    for (const stop of running.values()) stop();
    running.clear();
  };
}

function watchGuideRun(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
  runKey: string,
  watch: GuideRunWatch,
): () => void {
  const atom = pullRequestEnvironment.reviewGuide({
    environmentId: watch.environmentId,
    input: watch.reference,
  });
  let sawRunning = watch.answeredRunning === true;
  let subscribing = true;
  let seen: PullRequestReviewGuideResult | null = null;
  const onGuide = (data: PullRequestReviewGuideResult) => {
    if (data.run?._tag === "Running") {
      sawRunning = true;
      return;
    }
    const failure =
      data.run?._tag === "Failed" && data.run.failedAt !== watch.previousFailedAt
        ? data.run.detail
        : null;
    const written =
      failure === null && data.guide !== null && data.guide.generatedAt !== watch.previousGuideAt;
    if (failure === null && !written) {
      if (sawRunning || Date.now() - watch.since > UNSEEN_RUN_MS) {
        useGuideRunStore.getState().settle(runKey);
      }
      return;
    }
    const store = useGuideRunStore.getState();
    store.settle(runKey);
    const looking = document.visibilityState === "visible" && document.hasFocus();
    if (looking && isGuideShown(runKey)) return;

    const title = failure === null ? "Review guide ready" : "Review guide failed";
    const body =
      watch.title ??
      observedPullRequestTitle(registry, watch.environmentId, watch.reference) ??
      `${watch.reference.repository} #${watch.reference.number}`;
    const open = () => {
      useGuideRunStore.getState().showPageDetailTab(runKey, "guide");
      void router.navigate({
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
  };
  const unsubscribe = registry.subscribe(
    atom,
    (result) => {
      const data = Option.getOrNull(AsyncResult.value(result));
      if (data === null || data === seen) return;
      seen = data;
      if (subscribing && watch.answeredRunning === true) return;
      onGuide(data);
    },
    { immediate: true },
  );
  subscribing = false;
  const timer = setInterval(() => registry.refresh(atom), RUN_POLL_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
