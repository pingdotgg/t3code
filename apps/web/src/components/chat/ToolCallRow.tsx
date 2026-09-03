/**
 * Building blocks for a tool-call row in the chat timeline: the working
 * directory chip, the lightly coloured command text, the right-aligned meta
 * (duration, exit code, diff stat), and the expanded output / diff body.
 * All of it reads `ToolCallFacts`, so Codex, Claude, Cursor, Grok and
 * OpenCode calls render identically.
 */
import type { ToolCallFacts, ToolCallFactsFile, ToolCallFactsOutput } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { FileDiff } from "@pierre/diffs/react";
import { memo, useMemo } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { DiffStatLabel } from "./DiffStatLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TOOL_ROW_MONO_CLASS =
  "font-mono text-[length:var(--font-size-code,0.6875rem)] leading-relaxed";
/** Right-edge meta strip shared by the group header and each call row. */
export const TOOL_ROW_META_CLASS =
  "ms-2 flex shrink-0 items-center gap-2 text-[0.6875rem] tabular-nums text-muted-foreground";

/** Working directory as a short chip: workspace-relative, root shown as its basename. */
export const CwdChip = memo(function CwdChip(props: {
  cwd: string;
  workspaceRoot: string | undefined;
}) {
  const label = useMemo(() => {
    const relative = formatWorkspaceRelativePath(props.cwd, props.workspaceRoot);
    if (relative === "." || relative.length === 0 || relative === props.workspaceRoot) {
      const base = props.cwd
        .replace(/[\\/]+$/u, "")
        .split(/[\\/]/u)
        .at(-1);
      return base && base.length > 0 ? base : props.cwd;
    }
    return relative;
  }, [props.cwd, props.workspaceRoot]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="me-1.5 inline-block max-w-40 shrink-0 truncate rounded border border-border/60 bg-muted/40 px-1 align-[1px] text-[0.625rem] leading-4 text-muted-foreground">
            {label}
          </span>
        }
      />
      <TooltipPopup side="top">{props.cwd}</TooltipPopup>
    </Tooltip>
  );
});

type CommandToken = {
  readonly kind: "bin" | "flag" | "string" | "plain";
  readonly text: string;
  /** Character offset in the command; doubles as a stable render key. */
  readonly start: number;
};

/**
 * Three muted colours are enough for a row to scan as a command: the
 * program, its flags, and quoted strings. Anything richer competes with the
 * status colours that actually matter.
 */
export function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"|'[^']*'|\s+|[^\s"']+)/gu;
  let sawWord = false;
  let afterSeparator = true;
  for (const match of command.matchAll(pattern)) {
    const text = match[0];
    const start = match.index;
    if (/^\s+$/u.test(text)) {
      tokens.push({ kind: "plain", text, start });
      continue;
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      tokens.push({ kind: "string", text, start });
      afterSeparator = false;
      continue;
    }
    if (/^(?:&&|\|\||[|;])$/u.test(text)) {
      tokens.push({ kind: "plain", text, start });
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || !sawWord) {
      tokens.push({ kind: "bin", text, start });
      sawWord = true;
      afterSeparator = false;
      continue;
    }
    tokens.push({ kind: text.startsWith("-") ? "flag" : "plain", text, start });
  }
  return tokens;
}

export const CommandText = memo(function CommandText(props: {
  command: string;
  className?: string;
}) {
  const tokens = useMemo(() => tokenizeCommand(props.command), [props.command]);
  return (
    <span className={cn(TOOL_ROW_MONO_CLASS, "text-foreground/90", props.className)}>
      {tokens.map((token) => (
        <span
          key={token.start}
          className={
            token.kind === "bin"
              ? "text-info-foreground"
              : token.kind === "flag"
                ? "text-secondary-label"
                : token.kind === "string"
                  ? "text-warning"
                  : undefined
          }
        >
          {token.text}
        </span>
      ))}
    </span>
  );
});

/** Right edge of a row: duration, non-zero exit code, or +/- stat for edits. */
export const ToolRowMeta = memo(function ToolRowMeta(props: {
  durationMs: number | undefined;
  exitCode: number | undefined;
  diffStat: { additions: number; deletions: number } | null;
  running: boolean;
}) {
  const showExit = props.exitCode !== undefined && props.exitCode !== 0;
  if (!showExit && !props.diffStat && props.durationMs === undefined && !props.running) {
    return null;
  }
  return (
    <span className={TOOL_ROW_META_CLASS}>
      {props.diffStat ? (
        <DiffStatLabel
          additions={props.diffStat.additions}
          deletions={props.diffStat.deletions}
          layout="inline"
        />
      ) : null}
      {showExit ? (
        <span className="rounded bg-destructive/10 px-1 font-medium text-destructive">
          exit {props.exitCode}
        </span>
      ) : null}
      {props.running ? (
        <span className="rounded bg-info/10 px-1 font-medium text-info-foreground">running</span>
      ) : props.durationMs !== undefined ? (
        <span>{formatDuration(props.durationMs)}</span>
      ) : null}
    </span>
  );
});

/** First non-empty line of a failed call's output, shown without expanding. */
export function firstOutputLine(output: ToolCallFacts["output"] | undefined): string | null {
  const line = output?.text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line ? line.trim() : null;
}

export const ToolOutputBlock = memo(function ToolOutputBlock(props: {
  output: ToolCallFactsOutput;
  failed: boolean;
}) {
  const hiddenLines = props.output.truncated
    ? Math.max(0, props.output.lineCount - props.output.text.split("\n").length)
    : 0;
  return (
    <div className="min-w-0">
      <pre
        className={cn(
          TOOL_ROW_MONO_CLASS,
          "max-h-64 cursor-text overflow-auto whitespace-pre rounded-md bg-[var(--code-background)] px-2.5 py-1.5 select-text",
          props.failed ? "text-foreground/85" : "text-secondary-label",
        )}
      >
        {props.output.text}
      </pre>
      {props.output.truncated ? (
        <p className="mt-1 text-[0.6875rem] text-muted-foreground">
          {hiddenLines > 0
            ? `${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"} in the full output`
            : "Output cut short; the full output is longer"}
        </p>
      ) : null}
    </div>
  );
});

export const ToolFileDiffs = memo(function ToolFileDiffs(props: {
  files: ReadonlyArray<ToolCallFactsFile>;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  cacheKey: string;
}) {
  const patches = useMemo(
    () =>
      props.files.map((file) => ({
        file,
        renderable: file.diff
          ? getRenderablePatch(file.diff, `tool-row:${props.resolvedTheme}:${props.cacheKey}`)
          : null,
      })),
    [props.cacheKey, props.files, props.resolvedTheme],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {patches.map(({ file, renderable }) => (
        <div key={file.path} className="min-w-0">
          <div className={cn(TOOL_ROW_MONO_CLASS, "mb-1 flex items-center gap-2")}>
            <span className="min-w-0 truncate text-secondary-label">
              {formatWorkspaceRelativePath(file.path, props.workspaceRoot)}
            </span>
            {file.additions !== undefined || file.deletions !== undefined ? (
              <DiffStatLabel
                additions={file.additions ?? 0}
                deletions={file.deletions ?? 0}
                layout="inline"
              />
            ) : null}
          </div>
          {renderable?.kind === "files" ? (
            renderable.files.map((fileDiff) => (
              <FileDiff
                key={resolveFileDiffPath(fileDiff)}
                fileDiff={fileDiff}
                options={{
                  collapsed: false,
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(props.resolvedTheme),
                  preferredHighlighter: PREFERRED_HIGHLIGHTER,
                }}
              />
            ))
          ) : renderable?.kind === "raw" ? (
            <pre className={cn(TOOL_ROW_MONO_CLASS, "overflow-x-auto rounded-md bg-muted/40 p-2")}>
              {renderable.text}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
});
