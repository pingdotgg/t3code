import {
  Columns2Icon,
  EllipsisIcon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  TextWrapIcon,
} from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";

import { MorphIcon } from "~/components/MorphIcon";
import { updateClientSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Separator } from "../ui/separator";
import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The row widths below which the controls fold into the overflow menu.
const FOLD_CLASSES = {
  sm: {
    row: "hidden items-center gap-1 @sm/diff-toolbar:flex",
    menu: "flex @sm/diff-toolbar:hidden",
  },
  "2xl": {
    row: "hidden items-center gap-1 @2xl/diff-toolbar:flex",
    menu: "flex @2xl/diff-toolbar:hidden",
  },
} as const;

/**
 * The view controls every diff surface shares: layout, wrap, whitespace, file tree and fold-all.
 * Place it inside an `@container/diff-toolbar` row: narrow rows keep the layout toggle and move
 * the rest into an overflow menu.
 * A row whose other content needs the room folds below `2xl`.
 */
export function DiffViewControls({
  diffLayout,
  wordWrap,
  onWordWrapChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  hasFiles,
  foldBelow = "sm",
  fileTreeOpen,
  onFileTreeOpenChange,
  allFilesCollapsed,
  onToggleAllFiles,
  refresh,
  testFileCount = 0,
  hideTestFiles = false,
  onHideTestFilesChange,
}: {
  diffLayout: "stacked" | "split";
  wordWrap: boolean;
  onWordWrapChange: (wordWrap: boolean) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void;
  /** Fold-all and the file tree only mean something once there are files. */
  hasFiles: boolean;
  foldBelow?: keyof typeof FOLD_CLASSES;
  fileTreeOpen: boolean;
  onFileTreeOpenChange: (open: boolean) => void;
  allFilesCollapsed: boolean;
  onToggleAllFiles: () => void;
  refresh?: { refreshing: boolean; onRefresh: () => void } | undefined;
  testFileCount?: number;
  hideTestFiles?: boolean;
  onHideTestFilesChange?: (hidden: boolean) => void;
}) {
  const setDiffLayout = (value: unknown) => {
    if (value === "stacked" || value === "split") {
      updateClientSettings({ diffLayout: value });
    }
  };

  const fold = FOLD_CLASSES[foldBelow];
  return (
    <>
      <div className={fold.row}>
        {refresh && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={refresh.refreshing ? "Refreshing diff" : "Refresh diff"}
                  onClick={refresh.onRefresh}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={refresh.refreshing} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {refresh.refreshing ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {hasFiles && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={onToggleAllFiles}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div className="hidden @2xs/diff-toolbar:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={diffLayout === "split" ? "Stacked diff view" : "Split diff view"}
                variant="ghost"
                size="sm"
                pressed={diffLayout === "split"}
                onPressedChange={(pressed) => setDiffLayout(pressed ? "split" : "stacked")}
              />
            }
          >
            <Columns2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffLayout === "split" ? "Stacked view" : "Split view"}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className={fold.row}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => onWordWrapChange(Boolean(pressed))}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={ignoreWhitespace}
                onPressedChange={(pressed) => onIgnoreWhitespaceChange(Boolean(pressed))}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {testFileCount > 0 && onHideTestFilesChange && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Hide test files"
                  variant="ghost"
                  size="sm"
                  pressed={hideTestFiles}
                  onPressedChange={(pressed) => onHideTestFilesChange(Boolean(pressed))}
                />
              }
            >
              <FlaskConicalOffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {hideTestFiles
                ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
                : "Hide test files"}
            </TooltipPopup>
          </Tooltip>
        )}
        {hasFiles && <Separator orientation="vertical" className="mx-0.5 h-3.5" />}
        {hasFiles && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => onFileTreeOpenChange(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div className={fold.menu}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" />}
            aria-label="More diff actions"
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={diffLayout} onValueChange={setDiffLayout}>
              <DropdownMenuRadioItem value="stacked">Stacked view</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">Split view</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {refresh && (
              <DropdownMenuItem disabled={refresh.refreshing} onClick={refresh.onRefresh}>
                Refresh diff
              </DropdownMenuItem>
            )}
            {hasFiles && (
              <DropdownMenuItem onClick={onToggleAllFiles}>
                {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
              </DropdownMenuItem>
            )}
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={(checked) => onWordWrapChange(Boolean(checked))}
            >
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => onIgnoreWhitespaceChange(Boolean(checked))}
            >
              Hide whitespace changes
            </DropdownMenuCheckboxItem>
            {testFileCount > 0 && onHideTestFilesChange && (
              <DropdownMenuCheckboxItem
                checked={hideTestFiles}
                onCheckedChange={(checked) => onHideTestFilesChange(Boolean(checked))}
              >
                Hide test files
              </DropdownMenuCheckboxItem>
            )}
            {hasFiles && (
              <DropdownMenuCheckboxItem
                checked={fileTreeOpen}
                onCheckedChange={(checked) => onFileTreeOpenChange(Boolean(checked))}
              >
                File tree
              </DropdownMenuCheckboxItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
