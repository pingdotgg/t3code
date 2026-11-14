import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { toolCallDiff } from "../lib/toolCallDiff";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";
import { cn } from "~/lib/utils";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { FileExplorerPane } from "./files/FileExplorerPane";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import { useOpenLink } from "../browser/useOpenLink";

type DiffThemeType = "light" | "dark";

export const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
export const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";
export const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

export function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

export const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

export function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon
          className="size-4 text-muted-foreground/80"
          icon={collapsed ? ChevronRight : ChevronDown}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}

export function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}
