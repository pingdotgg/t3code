import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import {
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ClockIcon,
  EyeIcon,
  LayersIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PenLineIcon,
  UserLockIcon,
} from "lucide-react";

import type { PullRequestFilterOption } from "./PullRequestListFilters";
import type { PullRequestListSort } from "./pullRequestListPreferences";
import { PullRequestGlyph } from "./pullRequestIcons";

import { translateNow } from "../media/translateNow";
export const INVOLVEMENT_TABS = [
  {
    value: "all",
    get label() {
      return translateNow("review.extra.all");
    },
    Icon: LayersIcon,
  },
  {
    value: "reviewing",
    get label() {
      return translateNow("review.extra.reviewing");
    },
    Icon: EyeIcon,
  },
  {
    value: "authored",
    get label() {
      return translateNow("review.extra.authored");
    },
    Icon: PenLineIcon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

export const STATE_TABS = [
  {
    value: "all",
    get label() {
      return translateNow("review.extra.all");
    },
    Icon: LayersIcon,
  },
  {
    value: "open",
    get label() {
      return translateNow("review.extra.open");
    },
    Icon: PullRequestGlyph.pullRequest,
  },
  {
    value: "closed",
    get label() {
      return translateNow("review.extra.closed");
    },
    Icon: PullRequestGlyph.closed,
  },
  {
    value: "merged",
    get label() {
      return translateNow("review.extra.merged");
    },
    Icon: PullRequestGlyph.merged,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

export const SORT_OPTIONS = [
  {
    value: "ready",
    get label() {
      return translateNow("review.extra.merge.readiness");
    },
    Icon: ListChecksIcon,
  },
  {
    value: "blocked",
    get label() {
      return translateNow("review.extra.blocked.on.me");
    },
    Icon: UserLockIcon,
  },
  {
    value: "updated",
    get label() {
      return translateNow("review.extra.recently.updated");
    },
    Icon: ClockIcon,
  },
  {
    value: "newest",
    get label() {
      return translateNow("review.extra.newest.shown");
    },
    Icon: CalendarArrowDownIcon,
  },
  {
    value: "oldest",
    get label() {
      return translateNow("review.extra.oldest.shown");
    },
    Icon: CalendarArrowUpIcon,
  },
  {
    value: "largest",
    get label() {
      return translateNow("review.extra.largest.shown");
    },
    Icon: Maximize2Icon,
  },
  {
    value: "smallest",
    get label() {
      return translateNow("review.extra.smallest.shown");
    },
    Icon: Minimize2Icon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;
