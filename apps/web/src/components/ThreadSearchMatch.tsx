import {
  findSearchTokenRanges,
  splitSearchText,
  type SearchMatchHint,
  type SearchRange,
} from "@t3tools/shared/paletteSearch";
import { textDirection } from "~/textDirection";

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
    <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground/85" dir="ltr">
      <span className="shrink-0 text-muted-foreground/70">{props.hint.label}:</span>
      <bdi className="min-w-0 flex-1 truncate text-left" dir={textDirection(props.hint.text)}>
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
    <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground/85" dir="ltr">
      <span className={`shrink-0 ${isUser ? "text-info-foreground" : "text-success-foreground"}`}>
        {isUser ? "You:" : "Agent:"}
      </span>
      <bdi className="min-w-0 flex-1 truncate text-left" dir={textDirection(props.match.snippet)}>
        <HighlightedSearchText
          text={props.match.snippet}
          ranges={findSearchTokenRanges(props.match.snippet, props.match.query)}
        />
      </bdi>
    </span>
  );
}
