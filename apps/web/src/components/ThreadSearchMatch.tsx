import {
  findSearchTokenRanges,
  splitSearchText,
  type SearchMatchHint,
  type SearchRange,
} from "@t3tools/shared/paletteSearch";

/** `text` with each range in semibold foreground. */
export function HighlightedSearchText(props: { text: string; ranges: ReadonlyArray<SearchRange> }) {
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
    <span className="truncate text-xs text-muted-foreground/85">
      <span className="text-muted-foreground/70">{props.hint.label}:</span>{" "}
      <HighlightedSearchText text={props.hint.text} ranges={props.hint.ranges} />
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
    <span className="truncate text-xs text-muted-foreground/85">
      <span className={isUser ? "text-info-foreground" : "text-success-foreground"}>
        {isUser ? "You:" : "Agent:"}
      </span>{" "}
      <HighlightedSearchText
        text={props.match.snippet}
        ranges={findSearchTokenRanges(props.match.snippet, props.match.query)}
      />
    </span>
  );
}
