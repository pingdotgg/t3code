import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
} from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { resolveIssueStatePresentation } from "./issuePresentation";

describe("resolveIssueStatePresentation", () => {
  it.each([
    ["backlog", "open", "Queued", CircleDashedIcon, "text-muted-foreground/70"],
    [
      "unstarted",
      "open",
      "Todo",
      CircleDotIcon,
      PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
    ],
    ["started", "open", "In Review", CircleDotDashedIcon, "text-amber-600 dark:text-amber-300/90"],
    [
      "completed",
      "closed",
      "Done",
      CircleCheckIcon,
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    ],
    [
      "canceled",
      "closed",
      "Removed",
      CircleSlashIcon,
      PULL_REQUEST_STATE_PRESENTATION.draft.toneClassName,
    ],
  ] as const)(
    "restores the saved %s glyph with its native name",
    (workflowCategory, category, name, Icon, toneClassName) => {
      expect(
        resolveIssueStatePresentation({
          category,
          workflowCategory,
          name,
          ...(workflowCategory === "canceled" ? { closeReason: "canceled" } : {}),
          ...(workflowCategory === "completed" ? { closeReason: "completed" } : {}),
        }),
      ).toEqual({ Icon, toneClassName, label: name });
    },
  );

  it.each([
    ["not-planned", "canceled", "Closed as not planned", CircleSlashIcon],
    ["completed", "completed", "Closed as completed", CircleCheckIcon],
    ["duplicate", "completed", "Closed", CircleCheckIcon],
    [undefined, "completed", "Closed", CircleCheckIcon],
  ] as const)(
    "keeps close reason %s with the workflow glyph",
    (closeReason, workflowCategory, label, Icon) => {
      expect(
        resolveIssueStatePresentation({
          category: "closed",
          name: "closed",
          workflowCategory,
          ...(closeReason === undefined ? {} : { closeReason }),
        }),
      ).toMatchObject({ label, Icon });
    },
  );

  it.each([
    [
      { category: "open", name: "open" },
      CircleDotIcon,
      "Open",
      PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
    ],
    [
      { category: "open", name: "Active" },
      CircleDotIcon,
      "Active",
      PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
    ],
    [
      { category: "closed", name: "closed" },
      CircleCheckIcon,
      "Closed",
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    ],
    [
      { category: "closed", name: "Resolved" },
      CircleCheckIcon,
      "Resolved",
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    ],
    [
      { category: "closed", name: "closed", closeReason: "completed" },
      CircleCheckIcon,
      "Closed as completed",
      PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    ],
    [
      { category: "closed", name: "closed", closeReason: "not-planned" },
      CircleSlashIcon,
      "Closed as not planned",
      PULL_REQUEST_STATE_PRESENTATION.draft.toneClassName,
    ],
  ] as const)(
    "keeps the broad state and GitHub reason fallback: %j",
    (state, Icon, label, toneClassName) => {
      expect(resolveIssueStatePresentation(state)).toEqual({ Icon, label, toneClassName });
    },
  );
});
