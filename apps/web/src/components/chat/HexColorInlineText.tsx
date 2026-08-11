import type { ReactNode } from "react";

// Only the full `#RRGGBB` / `#RRGGBBAA` forms. The shorthand `#RGB` / `#RGBA`
// forms are indistinguishable from issue references like `#123` or `#5815`, and
// a swatch on an issue number is worse than a missing swatch on a color. The
// boundary guards keep hex runs inside longer tokens (`page#aabbcc`, `##aabbcc`,
// `#FF5733ZZ`) and HTML entities (`&#123456;`) plain.
const HEX_COLOR_TOKEN_REGEX = /(?<![\w#&])#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?(?![\w#])/g;

const HEX_COLOR_LITERAL_REGEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

/** The hex color an inline code span holds in full, or null when it holds anything else. */
export function parseHexColorLiteral(text: string): string | null {
  const trimmed = text.trim();
  return HEX_COLOR_LITERAL_REGEX.test(trimmed) ? trimmed : null;
}

// The literal it describes stays in the text, so the swatch is decorative:
// `aria-hidden` keeps it out of the accessibility tree, and out of the copied
// markdown too — `markdown-clipboard.ts` skips hidden elements.
export function HexColorSwatch(props: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="ml-[0.3em] inline-block size-[0.8em] shrink-0 rounded-[0.25em] border border-border/70 align-middle"
      style={{ backgroundColor: props.color }}
    />
  );
}

export function HexColorInlineText(props: { text: string }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of props.text.matchAll(HEX_COLOR_TOKEN_REGEX)) {
    const color = match[0];
    const start = match.index ?? 0;

    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    // The literal stays verbatim; nowrap keeps its swatch from wrapping alone.
    nodes.push(
      <span key={start} className="whitespace-nowrap">
        {color}
        <HexColorSwatch color={color} />
      </span>,
    );
    cursor = start + color.length;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}
