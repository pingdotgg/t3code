import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { ChevronDownIcon, FileIcon, TerminalIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { toolArgsToDiff } from "../lib/approvalDiff";
import {
  buildPatchCacheKey,
  DIFF_UNSAFE_CSS,
  resolveDiffThemeName,
} from "../lib/diffRendering";
import { cn } from "../lib/utils";

type DiffThemeType = "light" | "dark";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ApprovalDiffViewProps {
  args: unknown;
  requestKind: "command" | "file-read" | "file-change";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ApprovalDiffView = memo(function ApprovalDiffView({
  args,
  requestKind,
}: ApprovalDiffViewProps) {
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  const result = useMemo(() => toolArgsToDiff(args, requestKind), [args, requestKind]);

  if (result.kind === "unknown") {
    return null;
  }

  if (result.kind === "command") {
    return (
      <div className="px-4 pb-3">
        <button
          type="button"
          className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground/80 hover:text-foreground/80"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <ChevronDownIcon
            className={cn(
              "size-3 transition-transform",
              collapsed && "-rotate-90",
            )}
          />
          <TerminalIcon className="size-3" />
          <span className="font-medium">Command</span>
        </button>
        {!collapsed && (
          <pre className="overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
            {result.command}
          </pre>
        )}
      </div>
    );
  }

  if (result.kind === "file-read") {
    return (
      <div className="flex items-center gap-1.5 px-4 pb-3 text-xs text-muted-foreground/80">
        <FileIcon className="size-3" />
        <span className="font-mono">{result.filePath}</span>
      </div>
    );
  }

  // result.kind === "diff"
  return (
    <ApprovalFileDiff
      patch={result.patch}
      filePath={result.filePath}
      resolvedTheme={resolvedTheme}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((prev) => !prev)}
    />
  );
});

// ---------------------------------------------------------------------------
// File diff sub-component
// ---------------------------------------------------------------------------

interface ApprovalFileDiffProps {
  patch: string;
  filePath: string;
  resolvedTheme: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function parseApprovalPatch(
  patch: string,
  cacheScope: string,
): FileDiffMetadata[] | null {
  try {
    const normalizedPatch = patch.trim();
    if (normalizedPatch.length === 0) return null;
    const parsed = parsePatchFiles(normalizedPatch, buildPatchCacheKey(normalizedPatch, cacheScope));
    const files = parsed.flatMap((p) => p.files);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

const ApprovalFileDiff = memo(function ApprovalFileDiff({
  patch,
  filePath,
  resolvedTheme,
  collapsed,
  onToggleCollapsed,
}: ApprovalFileDiffProps) {
  const cacheScope = `approval-diff:${resolvedTheme}`;
  const files = useMemo(() => parseApprovalPatch(patch, cacheScope), [patch, cacheScope]);

  return (
    <div className="px-4 pb-3">
      <button
        type="button"
        className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground/80 hover:text-foreground/80"
        onClick={onToggleCollapsed}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <FileIcon className="size-3" />
        <span className="font-mono font-medium truncate">{filePath}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[40vh] overflow-auto rounded-md border border-border/70">
          {files ? (
            files.map((fileDiff, index) => (
              <FileDiff
                key={`${fileDiff.cacheKey ?? index}`}
                fileDiff={fileDiff}
                options={{
                  diffStyle: "unified",
                  lineDiffType: "none",
                  theme: resolveDiffThemeName(resolvedTheme as DiffThemeType),
                  themeType: resolvedTheme as DiffThemeType,
                  unsafeCSS: DIFF_UNSAFE_CSS,
                }}
              />
            ))
          ) : (
            <pre className="overflow-auto bg-background/70 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground/90">
              {patch}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
