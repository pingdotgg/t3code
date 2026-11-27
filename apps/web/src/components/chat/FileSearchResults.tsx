import type { OrchestrationV2FileSearchResult } from "@t3tools/contracts";
import { groupFileSearchResults } from "@t3tools/client-runtime/work-log/item-detail";
import { splitSearchText, type SearchRange } from "@t3tools/shared/paletteSearch";
import { useGT } from "gt-react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";

const MAX_HIGHLIGHTS_PER_LINE = 20;
const MAX_HIGHLIGHTED_LINE_CHARS = 1_000;

// JavaScript backtracks where ripgrep runs in linear time, and the work multiplies with every
// quantifier and alternation. One quantifier (not on a group) and three `|` keep a match within
// about 8·n² steps; other patterns could hang rendering, so they go unhighlighted.
function backtracksSafely(pattern: string) {
  const unescaped = pattern.replace(/\\./g, "");
  return (
    (unescaped.match(/[*+?{]/g) ?? []).length <= 1 &&
    (unescaped.match(/\|/g) ?? []).length <= 3 &&
    !/\)[*+{]/.test(unescaped)
  );
}

// Provider patterns are ripgrep regexes; JavaScript reads most of them the same way. Every
// matched line is known to match, so when the case-sensitive form misses one the search
// was case-insensitive. A pattern JavaScript can't parse just goes unhighlighted.
function patternMatchers(pattern: string | undefined): ReadonlyArray<RegExp> {
  if (!pattern?.trim() || !backtracksSafely(pattern)) return [];
  try {
    return [new RegExp(pattern, "g"), new RegExp(pattern, "gi")];
  } catch {
    return [];
  }
}

function matchRanges(text: string, matchers: ReadonlyArray<RegExp>): ReadonlyArray<SearchRange> {
  if (text.length > MAX_HIGHLIGHTED_LINE_CHARS) return [];
  for (const matcher of matchers) {
    const ranges: SearchRange[] = [];
    for (const match of text.matchAll(matcher)) {
      if (match[0].length === 0) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (ranges.length === MAX_HIGHLIGHTS_PER_LINE) break;
    }
    if (ranges.length > 0) return ranges;
  }
  return [];
}

function MatchedLine(props: { readonly text: string; readonly matchers: ReadonlyArray<RegExp> }) {
  const ranges = matchRanges(props.text, props.matchers);
  if (ranges.length === 0) return props.text;
  return splitSearchText(props.text, ranges).map((part) =>
    part.highlighted ? (
      <mark key={part.start} className="rounded-xs bg-warning/20 text-foreground">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function FilePath(props: { readonly path: string }) {
  const slash = props.path.lastIndexOf("/");
  return (
    <span className="min-w-0 truncate">
      {slash >= 0 ? (
        <span className="text-muted-foreground/70">{props.path.slice(0, slash + 1)}</span>
      ) : null}
      <span className="text-foreground/90">{props.path.slice(slash + 1)}</span>
    </span>
  );
}

export function FileSearchResults(props: {
  readonly pattern: string | undefined;
  readonly results: ReadonlyArray<OrchestrationV2FileSearchResult>;
  readonly workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const matchers = patternMatchers(props.pattern);
  return (
    <div className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/70 bg-muted/45 font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text">
      {groupFileSearchResults(props.results).map((group) => {
        const lines = group.results.filter((result) => result.line !== undefined);
        const notes = group.results.flatMap((result) =>
          result.line === undefined && result.preview?.trim() ? [result.preview.trimEnd()] : [],
        );
        const [firstNote] = notes;
        const inlineNote =
          lines.length === 0 &&
          notes.length === 1 &&
          firstNote !== undefined &&
          !firstNote.includes("\n");
        return (
          <section key={group.fileName} className="min-w-0 px-2.5 py-1.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <FilePath path={formatWorkspaceRelativePath(group.fileName, props.workspaceRoot)} />
              {lines.length > 1 ? (
                <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                  {gt("{count, plural, one {{count} match} other {{count} matches}}", {
                    count: lines.length,
                  })}
                </span>
              ) : null}
              {inlineNote ? (
                <span className="shrink-0 text-muted-foreground/70">{firstNote}</span>
              ) : null}
            </div>
            {lines.length > 0 ? (
              <div className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                {lines.map((result) => (
                  <div key={`${result.line}:${result.column ?? ""}`} className="contents">
                    <span className="text-right text-muted-foreground/45 tabular-nums select-none">
                      {result.line}
                    </span>
                    <span className="line-clamp-3 break-words whitespace-pre-wrap text-muted-foreground">
                      <MatchedLine text={result.preview?.trim() ?? ""} matchers={matchers} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {!inlineNote && notes.length > 0 ? (
              <pre className="mt-0.5 break-words whitespace-pre-wrap text-muted-foreground">
                {notes.join("\n")}
              </pre>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
