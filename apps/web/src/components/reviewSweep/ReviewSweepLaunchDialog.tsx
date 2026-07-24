import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { setSweepResultsNavigator, useReviewSweepStore } from "../../reviewSweepStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { SweepPreRunSummary } from "./ReviewSweepView";

/** Launch modal for the work-review sweep. The sweep itself runs in the
    background (module-level runner), so the modal just confirms scope/cost
    and closes; a toast announces completion with a link to the results. */
export function ReviewSweepLaunchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const phase = useReviewSweepStore((state) => state.phase);

  // Install the navigator the store's completion toast uses. The dialog is
  // mounted for the sidebar's lifetime, so this stays registered.
  useEffect(() => {
    setSweepResultsNavigator(() => {
      void router.navigate({ to: "/review-sweep" });
    });
    return () => setSweepResultsNavigator(null);
  }, [router]);

  const handleStarted = () => {
    onOpenChange(false);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Reviewing your work in the background",
        description: "You'll get a notification when the results are ready.",
        actionVariant: "outline",
        actionProps: {
          children: "Watch progress",
          onClick: () => void router.navigate({ to: "/review-sweep" }),
        },
      }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review unsettled work</DialogTitle>
          <DialogDescription>
            {phase === "running"
              ? "A review is already running — results will arrive as a notification."
              : "One AI review per unsettled thread, run in the background."}
          </DialogDescription>
        </DialogHeader>
        {phase === "running" ? null : <SweepPreRunSummary onStarted={handleStarted} />}
      </DialogPopup>
    </Dialog>
  );
}
