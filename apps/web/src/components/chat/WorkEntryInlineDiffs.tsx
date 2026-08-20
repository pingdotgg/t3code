import { type EnvironmentId } from "@t3tools/contracts";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { FileChange } from "../../session-logic";
import {
  getDiffLineStat,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { TextWrapIcon } from "lucide-react";
import { DiffStatLabel } from "./DiffStatLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";
import { useExpandedFileDiff } from "./useExpandedFileDiff";

export function buildInlineFileChangePatch(change: FileChange): string | null {
  const patch = change.patch?.trim();
  if (!patch) return null;
  if (patch.startsWith("diff --git ") || /^--- .*\r?\n\+\+\+ /.test(patch)) {
    return patch;
  }
  const path = change.filePath;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, patch].join("\n");
}

const EXPANSION_ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  changed: {
    title: "Cannot expand unchanged lines",
    description: "The file changed after this edit.",
  },
  patch: {
    title: "Cannot expand unchanged lines",
    description: "The stored edit no longer applies to this file.",
  },
  "read-error": {
    title: "Cannot expand unchanged lines",
    description: "The file could not be read.",
  },
  "missing-hash": {
    title: "Cannot expand unchanged lines",
    description: "This edit predates unchanged-line tracking.",
  },
  truncated: {
    title: "Cannot expand unchanged lines",
    description: "The file is too large to verify the edit.",
  },
};

export function InlineFileDiff(props: {
  change: FileChange;
  fileDiff: FileDiffMetadata;
  environmentId: EnvironmentId;
  workspaceRoot: string | undefined;
  theme: "light" | "dark";
  wordWrap: boolean;
  onToggleWordWrap: () => void;
}) {
  const { expandedFileDiff, expansionError } = useExpandedFileDiff(
    props.change,
    props.fileDiff,
    props.environmentId,
    props.workspaceRoot,
  );

  const warnCannotExpand = () => {
    const msg = EXPANSION_ERROR_MESSAGES[expansionError ?? "read-error"];
    toastManager.add({ type: "warning", ...msg });
  };

  const stat = getDiffLineStat([expandedFileDiff]);
  return (
    <div>
      <FileDiff
        fileDiff={expandedFileDiff}
        renderCustomHeader={(headerFileDiff) => (
          <div className="flex h-10 items-center gap-2 px-3 text-xs">
            <span className="min-w-0 flex-1 truncate">{resolveFileDiffPath(headerFileDiff)}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label={
                      props.wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                    }
                    variant="ghost"
                    size="xs"
                    pressed={props.wordWrap}
                    onPressedChange={props.onToggleWordWrap}
                  />
                }
              >
                <TextWrapIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {props.wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
              </TooltipPopup>
            </Tooltip>
            <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" />
          </div>
        )}
        options={{
          collapsed: false,
          diffStyle: "unified",
          expansionLineCount: 10,
          overflow: props.wordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(props.theme),
          onHunkExpand: expandedFileDiff.isPartial ? warnCannotExpand : undefined,
        }}
      />
    </div>
  );
}
