import { t } from "@palamedes/core/macro";
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

export const INVOLVEMENT_TABS = [
  {
    value: "all",
    get label() {
      return t({ message: "All" });
    },
    Icon: LayersIcon,
  },
  {
    value: "reviewing",
    get label() {
      return t({ message: "Reviewing" });
    },
    Icon: EyeIcon,
  },
  {
    value: "authored",
    get label() {
      return t({ message: "Authored" });
    },
    Icon: PenLineIcon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

export const STATE_TABS = [
  {
    value: "all",
    get label() {
      return t({ message: "All" });
    },
    Icon: LayersIcon,
  },
  {
    value: "open",
    get label() {
      return t({ message: "Open" });
    },
    Icon: PullRequestGlyph.pullRequest,
  },
  {
    value: "closed",
    get label() {
      return t({ message: "Closed" });
    },
    Icon: PullRequestGlyph.closed,
  },
  {
    value: "merged",
    get label() {
      return t({ message: "Merged" });
    },
    Icon: PullRequestGlyph.merged,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

export const SORT_OPTIONS = [
  {
    value: "ready",
    get label() {
      return t({ message: "Merge readiness" });
    },
    Icon: ListChecksIcon,
  },
  {
    value: "blocked",
    get label() {
      return t({ message: "Blocked on me" });
    },
    Icon: UserLockIcon,
  },
  {
    value: "updated",
    get label() {
      return t({ message: "Recently updated" });
    },
    Icon: ClockIcon,
  },
  {
    value: "newest",
    get label() {
      return t({ message: "Newest shown" });
    },
    Icon: CalendarArrowDownIcon,
  },
  {
    value: "oldest",
    get label() {
      return t({ message: "Oldest shown" });
    },
    Icon: CalendarArrowUpIcon,
  },
  {
    value: "largest",
    get label() {
      return t({ message: "Largest shown" });
    },
    Icon: Maximize2Icon,
  },
  {
    value: "smallest",
    get label() {
      return t({ message: "Smallest shown" });
    },
    Icon: Minimize2Icon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;
