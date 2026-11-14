import {
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestListEntry,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { type DraftId } from "~/composerDraftStore";
import { type PullRequestDetailTab } from "~/rightPanelStore";

import { type ShortcutMatchContext } from "~/keybindings";

/** What the pull request detail panel is asked to show and report back. */
export interface PullRequestDetailPanelProps {
  environmentId: EnvironmentId;
  shortcutsEnabled: boolean;
  getShortcutContext: () => ShortcutMatchContext;
  onSelectPullRequest?: ((reference: PullRequestRef) => void) | undefined;
  threadRef?: ScopedThreadRef | null;
  reference: PullRequestRef;
  listEntry?: PullRequestListEntry | null;
  refreshToken?: number;
  /**
   * The pull requests page's panel: its tab lives in the guide run store, where a review guide
   * notification can switch it.
   */
  tabOnPage?: boolean;
  onActed?: (action?: PullRequestAction, phase?: "sent" | "done" | "failed") => void;
  onClose?: () => void;
  context?: "page" | "thread";
  composerDraftTarget?: ScopedThreadRef | DraftId;
  onBack?: (() => void) | undefined;
  onGuideShown?: (() => void) | undefined;
  initialTab?: PullRequestDetailTab;
  onTabChange?: ((tab: PullRequestDetailTab) => void) | undefined;
}
