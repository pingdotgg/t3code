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
  { value: "all", label: "list.involvement.all", Icon: LayersIcon },
  { value: "reviewing", label: "list.involvement.reviewing", Icon: EyeIcon },
  { value: "authored", label: "list.involvement.authored", Icon: PenLineIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;

export const STATE_TABS = [
  { value: "all", label: "list.state.all", Icon: LayersIcon },
  { value: "open", label: "list.state.open", Icon: PullRequestGlyph.pullRequest },
  { value: "closed", label: "list.state.closed", Icon: PullRequestGlyph.closed },
  { value: "merged", label: "list.state.merged", Icon: PullRequestGlyph.merged },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;

export const SORT_OPTIONS = [
  { value: "ready", label: "list.sort.ready", Icon: ListChecksIcon },
  { value: "blocked", label: "list.sort.blocked", Icon: UserLockIcon },
  { value: "updated", label: "list.sort.updated", Icon: ClockIcon },
  { value: "newest", label: "list.sort.newest", Icon: CalendarArrowDownIcon },
  { value: "oldest", label: "list.sort.oldest", Icon: CalendarArrowUpIcon },
  { value: "largest", label: "list.sort.largest", Icon: Maximize2Icon },
  { value: "smallest", label: "list.sort.smallest", Icon: Minimize2Icon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<PullRequestListSort>>;
