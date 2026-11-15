import { useAtomValue } from "@effect/atom-react";
import type { BoatCloudStartStep, BoatCloudStepProgress } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleIcon, CircleXIcon } from "lucide-react";

import { boatCloudStartProgressAtom, clearBoatCloudStartProgress } from "../../boatCloud";
import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { BoatIcon } from "../Icons";
import { Text } from "../ui/text";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const STEP_LABELS: Record<BoatCloudStartStep, string> = {
  machine: "Find a VM",
  server: "Start T3 Code",
  repository: "Clone or update the repository",
  connect: "Connect",
  project: "Open the project",
  thread: "Start the thread",
};

const STEP_STATE_LABELS: Record<BoatCloudStepProgress["state"], string> = {
  pending: "Pending",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};

// Static on purpose: a start can take a minute, and a spinner repaints the whole time.
function StepIcon({ state }: { readonly state: BoatCloudStepProgress["state"] }) {
  switch (state) {
    case "done":
      return <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />;
    case "failed":
      return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />;
    case "active":
      return <CircleDotIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />;
    case "pending":
      return <CircleIcon aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />;
  }
}

function StartSteps({ steps }: { readonly steps: ReadonlyArray<BoatCloudStepProgress> }) {
  return (
    <ol className="grid gap-1 py-0.5">
      {steps.map((entry) => (
        <li
          key={entry.step}
          data-boat-cloud-step={entry.step}
          data-state={entry.state}
          className="flex min-w-0 items-center gap-2"
        >
          <StepIcon state={entry.state} />
          <span className="sr-only">{STEP_STATE_LABELS[entry.state]}:</span>
          <Text variant="meta" tone={entry.state === "pending" ? "muted" : "default"} truncate>
            {STEP_LABELS[entry.step]}
          </Text>
          {entry.detail ? (
            <Text variant="caption" tone="muted" truncate>
              {entry.detail}
            </Text>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The steps of a Boat cloud start for this draft, above its composer until the thread exists. */
export function useBoatCloudStartBanner(
  draftId: DraftId | null,
  draftThread: DraftSessionState | null,
): ComposerBannerStackItem | null {
  const progress = useAtomValue(boatCloudStartProgressAtom(draftId ?? ""));
  if (
    draftId === null ||
    progress === null ||
    draftThread?.environmentSelection !== "cloud" ||
    draftThread.promotedTo
  ) {
    return null;
  }
  const failed = progress.error !== null;
  return {
    id: `boat-cloud-start:${draftId}`,
    group: "environment",
    variant: failed ? "error" : "info",
    icon: <BoatIcon aria-hidden />,
    title: failed ? "Could not start on Boat cloud" : "Starting on Boat cloud",
    ...(failed
      ? {
          description: progress.error,
          dismissLabel: "Dismiss",
          onDismiss: () => clearBoatCloudStartProgress(draftId),
        }
      : {}),
    children: <StartSteps steps={progress.steps} />,
  };
}
