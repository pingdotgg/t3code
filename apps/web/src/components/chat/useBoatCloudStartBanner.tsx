import { useAtomValue } from "@effect/atom-react";

import { boatCloudStartProgressAtom, clearBoatCloudStartProgress } from "../../boatCloud";
import { stepsLeftAtSend } from "../../boatCloudStart.logic";
import {
  type DraftId,
  type DraftSessionState,
  isCloudEnvironmentSelection,
} from "../../composerDraftStore";
import { BoatIcon, BoxdIcon } from "../Icons";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { BoatCloudStartRowsState } from "./WorktreeSetupCard";

/**
 * A Boat cloud start runs quietly behind the composer. Once a message waits on it, the thread
 * shows the steps still left, timed from the send; a failure shows as a banner until dismissed.
 */
export function useBoatCloudStartBanner(
  draftId: DraftId | null,
  draftThread: DraftSessionState | null,
): {
  bannerItem: ComposerBannerStackItem | null;
  threadRows: BoatCloudStartRowsState | null;
  sentAt: string | null;
} {
  const progress = useAtomValue(boatCloudStartProgressAtom(draftId ?? ""));
  if (
    draftId === null ||
    progress === null ||
    !isCloudEnvironmentSelection(draftThread?.environmentSelection) ||
    draftThread?.promotedTo
  ) {
    return { bannerItem: null, threadRows: null, sentAt: null };
  }
  const steps = stepsLeftAtSend(progress);
  const threadRows = steps ? { steps, repository: progress.repository } : null;
  const sentAt = threadRows ? (progress.sent?.at ?? null) : null;
  if (progress.error === null) return { bannerItem: null, threadRows, sentAt };
  const boxd = draftThread?.environmentSelection === "boxd";
  return {
    bannerItem: {
      id: `boat-cloud-start:${draftId}`,
      group: "environment",
      variant: "error",
      icon: boxd ? <BoxdIcon aria-hidden /> : <BoatIcon aria-hidden />,
      title: boxd ? "Could not start on boxd cloud" : "Could not start on Boat cloud",
      description: progress.error,
      dismissLabel: "Dismiss",
      onDismiss: () => clearBoatCloudStartProgress(draftId),
    },
    threadRows,
    sentAt,
  };
}
