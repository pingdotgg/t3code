import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import {
  findSearchTokenRanges,
  splitSearchText,
  type SearchMatchHint,
  type SearchRange,
} from "@t3tools/shared/paletteSearch";

// The text truncates in its own box and direction, so a right-to-left match loses its end, not its start.
const SEARCH_LINE_CLASS = "flex min-w-0 items-baseline text-xs text-muted-foreground/85";
const SEARCH_TEXT_CLASS = "min-w-0 flex-1 truncate text-left";

/** `text` with each range in semibold foreground. */
function HighlightedSearchText(props: { text: string; ranges: ReadonlyArray<SearchRange> }) {
  if (props.ranges.length === 0) return props.text;
  return splitSearchText(props.text, props.ranges).map((part) =>
    part.highlighted ? (
      <mark className="bg-transparent font-semibold text-foreground" key={part.start}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/** Why a row matched when its title does not show it: the field and its match. */
export function SearchMatchHintLine(props: { hint: SearchMatchHint }) {
  return (
    <span className={SEARCH_LINE_CLASS}>
      <span className="shrink-0 whitespace-pre text-muted-foreground/70">{props.hint.label}: </span>
      <bdi className={SEARCH_TEXT_CLASS} dir={textDirection(props.hint.text)}>
        <HighlightedSearchText text={props.hint.text} ranges={props.hint.ranges} />
      </bdi>
    </span>
  );
}

export function ThreadSearchMatchExcerpt(props: {
  match: {
    readonly source: "user" | "assistant";
    readonly snippet: string;
    readonly query: string;
  };
}) {
  const isUser = props.match.source === "user";
  return (
    <span className={SEARCH_LINE_CLASS}>
      <span
        className={cn(
          "shrink-0 whitespace-pre",
          isUser ? "text-info-foreground" : "text-success-foreground",
        )}
      >
        {isUser ? "You: " : "Agent: "}
      </span>
      <bdi className={SEARCH_TEXT_CLASS} dir={textDirection(props.match.snippet)}>
        <HighlightedSearchText
          text={props.match.snippet}
          ranges={findSearchTokenRanges(props.match.snippet, props.match.query)}
        />
      </bdi>
    </span>
  );
}
