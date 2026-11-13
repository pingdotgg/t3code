import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  SourceControlProviderKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  GitRunStackedActionResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlProviderDiscoveryItem,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { useNowSecond } from "../hooks/useNowSecond";
import { flushSync } from "react-dom";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup } from "~/components/ui/radio-group";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import {
  buildMenuItems,
  formatGitActionElapsed,
  GIT_ACTION_SUCCESS_VISIBLE_MS,
  type GitActionProgressPresentation,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveChangesTotals,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  resolveGitActionProgressPresentation,
  resolveGitActionResultToastTiming,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { WizardPopup, WizardHeader, WizardSteps, WizardPanel, WizardFooter } from "./ui/wizard";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useSourceControlPublishRepositoryAction,
  useVcsInitAction,
  useVcsPullAction,
} from "../state/sourceControlActions";
import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { getSourceControlPresentation, sourceControlIcon } from "~/sourceControlPresentation";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useOpenLink } from "~/browser/useOpenLink";

export function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: check out a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (!hasBranch) {
    return `Detached HEAD: check out a branch before creating a ${terminology.singular}.`;
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

