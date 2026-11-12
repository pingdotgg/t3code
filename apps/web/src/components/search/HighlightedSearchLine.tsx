import { getFiletypeFromFileName } from "@pierre/diffs";
import type { ProjectContentMatch } from "@t3tools/contracts";
import { memo, Suspense, use, type CSSProperties } from "react";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

interface Range {
  readonly start: number;
  readonly end: number;
}

interface CodeToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

interface Segment {
  readonly content: string;
  readonly isMatch: boolean;
  readonly start: number;
  readonly end: number;
  readonly token: CodeToken;
}

function normalizeRanges(match: ProjectContentMatch): Range[] {
  const ranges = match.matchRanges
    .map((range) => ({
      start: Math.max(0, Math.min(match.lineContent.length, range.start)),
      end: Math.max(0, Math.min(match.lineContent.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function splitToken(line: string, token: CodeToken, ranges: ReadonlyArray<Range>): Segment[] {
  const segments: Segment[] = [];
  const tokenEnd = token.offset + token.content.length;
  let cursor = token.offset;

  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= tokenEnd) break;

    const matchStart = Math.max(cursor, range.start);
    if (matchStart > cursor) {
      segments.push({
        content: line.slice(cursor, matchStart),
        isMatch: false,
        start: cursor,
        end: matchStart,
        token,
      });
    }

    const matchEnd = Math.min(tokenEnd, range.end);
    segments.push({
      content: line.slice(matchStart, matchEnd),
      isMatch: true,
      start: matchStart,
      end: matchEnd,
      token,
    });
    cursor = matchEnd;
  }

  if (cursor < tokenEnd) {
    segments.push({
      content: line.slice(cursor, tokenEnd),
      isMatch: false,
      start: cursor,
      end: tokenEnd,
      token,
    });
  }
  return segments;
}

function tokenStyle(token: CodeToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

function HighlightedTokens(props: {
  readonly line: string;
  readonly ranges: ReadonlyArray<Range>;
  readonly tokens: ReadonlyArray<CodeToken>;
}) {
  return props.tokens
    .flatMap((token) => splitToken(props.line, token, props.ranges))
    .map((segment) =>
      segment.isMatch ? (
        <mark
          className="rounded-xs bg-primary/25 text-inherit"
          key={`${segment.start}:${segment.end}:match`}
          style={tokenStyle(segment.token)}
        >
          {segment.content}
        </mark>
      ) : (
        <span key={`${segment.start}:${segment.end}:code`} style={tokenStyle(segment.token)}>
          {segment.content}
        </span>
      ),
    );
}

function firstLineTokens(
  highlighter: Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>,
  line: string,
  language: string,
  theme: "light" | "dark",
) {
  try {
    return highlighter.codeToTokens(line, { lang: language, theme: resolveDiffThemeName(theme) })
      .tokens[0];
  } catch {
    return undefined;
  }
}

function SyntaxHighlightedTokens(props: {
  readonly line: string;
  readonly language: string;
  readonly ranges: ReadonlyArray<Range>;
  readonly theme: "light" | "dark";
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const tokens = firstLineTokens(highlighter, props.line, props.language, props.theme);

  return tokens ? (
    <HighlightedTokens line={props.line} ranges={props.ranges} tokens={tokens} />
  ) : (
    <HighlightedTokens
      line={props.line}
      ranges={props.ranges}
      tokens={[{ content: props.line, offset: 0 }]}
    />
  );
}

export const HighlightedSearchLine = memo(function HighlightedSearchLine(props: {
  readonly match: ProjectContentMatch;
  readonly path: string;
  readonly theme: "light" | "dark";
}) {
  const ranges = normalizeRanges(props.match);
  const fallback = (
    <HighlightedTokens
      line={props.match.lineContent}
      ranges={ranges}
      tokens={[{ content: props.match.lineContent, offset: 0 }]}
    />
  );

  return (
    <RenderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <SyntaxHighlightedTokens
          line={props.match.lineContent}
          language={getFiletypeFromFileName(props.path)}
          ranges={ranges}
          theme={props.theme}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
});
