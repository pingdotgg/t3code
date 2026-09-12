/** @jsxImportSource react */
import { Box as SigilBox, type DOMElement } from "@alchemy.run/sigil";
import {
  forwardRef,
  type ComponentProps,
  type ForwardRefExoticComponent,
  type PropsWithoutRef,
  type ReactNode,
  type RefAttributes,
} from "react";
import { theme } from "../../../Util/Theme.ts";
import { useCliEnvironment, useGlyphs } from "./Environment.tsx";
import { Text } from "./Typography.tsx";

// Windowed list that clips to the rows its container leaves over; it draws no
// colors of its own, so it needs no theme-aware wrapper.
export { VirtualList } from "@alchemy.run/sigil";

export type BoxProps = ComponentProps<typeof SigilBox>;

/** Theme-aware Sigil container used by CliKit layouts. */
export const Box: ForwardRefExoticComponent<
  PropsWithoutRef<BoxProps> & RefAttributes<DOMElement>
> = forwardRef<DOMElement, BoxProps>(function Box(props, ref) {
  const { colors } = useCliEnvironment();
  const {
    borderColor: _borderColor,
    borderTopColor: _borderTopColor,
    borderBottomColor: _borderBottomColor,
    borderLeftColor: _borderLeftColor,
    borderRightColor: _borderRightColor,
    borderBackgroundColor: _borderBackgroundColor,
    borderTopBackgroundColor: _borderTopBackgroundColor,
    borderBottomBackgroundColor: _borderBottomBackgroundColor,
    borderLeftBackgroundColor: _borderLeftBackgroundColor,
    borderRightBackgroundColor: _borderRightBackgroundColor,
    backgroundColor: _backgroundColor,
    borderDimColor: _borderDimColor,
    borderTopDimColor: _borderTopDimColor,
    borderBottomDimColor: _borderBottomDimColor,
    borderLeftDimColor: _borderLeftDimColor,
    borderRightDimColor: _borderRightDimColor,
    ...colorless
  } = props;
  return <SigilBox {...(colors ? props : colorless)} ref={ref} />;
});

export interface StackProps extends Omit<BoxProps, "flexDirection"> {
  readonly gap?: number;
}

/** Vertical layout primitive. */
export function Stack({ children, gap = 0, ...props }: StackProps) {
  return (
    <Box flexDirection="column" gap={gap} {...props}>
      {children}
    </Box>
  );
}

export interface RowProps extends Omit<
  BoxProps,
  "flexDirection" | "alignItems" | "justifyContent"
> {
  readonly gap?: number;
  readonly align?: "flex-start" | "center" | "flex-end";
  readonly justify?:
    | "flex-start"
    | "center"
    | "flex-end"
    | "space-between"
    | "space-around";
}

/** Horizontal layout primitive. */
export function Row({
  children,
  gap = 1,
  align = "flex-start",
  justify = "flex-start",
  ...props
}: RowProps) {
  return (
    <Box
      flexDirection="row"
      gap={gap}
      alignItems={align}
      justifyContent={justify}
      {...props}
    >
      {children}
    </Box>
  );
}

type HeadingProps = {
  readonly children?: ReactNode;
  /** Set false to drop the section glyph prefix (e.g. help-screen headings). */
  readonly glyph?: boolean;
};

export function Heading({ children, glyph = true }: HeadingProps) {
  const glyphs = useGlyphs();
  return (
    <Box>
      <Text bold color={theme.color.brand}>
        {glyph ? `${glyphs.section} ` : null}
        {children}
      </Text>
    </Box>
  );
}

type SectionHeadingProps = {
  readonly children?: ReactNode;
  readonly annotation?: ReactNode;
};

export function SectionHeading({ children, annotation }: SectionHeadingProps) {
  return (
    <Text>
      <Text bold color={theme.color.brand}>
        {children}
      </Text>
      {annotation === undefined ? null : (
        <Text tone="muted"> · {annotation}</Text>
      )}
    </Text>
  );
}

type GutterProps = {
  readonly depth?: number;
  readonly children?: ReactNode;
};

export function Gutter({ depth = 1, children }: GutterProps) {
  return (
    <Box paddingLeft={Math.max(0, depth) * theme.space.indent}>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The centering clamp shared by every windowed list: a window of `count` rows
 * over `length` items keeping `cursor` as close to the middle as the list
 * bounds allow.
 */
export const listWindow = (
  length: number,
  cursor: number,
  count: number,
): { readonly start: number; readonly end: number } => {
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(count / 2), length - count),
  );
  return { start, end: Math.min(length, start + count) };
};

/**
 * Horizontal window over variable-width items (tab chips): expands around
 * `active` — alternating right/left so the selection stays roughly centered —
 * until `available` columns are exhausted. Returns `[start, end)` like
 * {@link listWindow}; `active` is always inside the window.
 */
export const tabsWindow = (
  widths: ReadonlyArray<number>,
  active: number,
  available: number,
  gap = 1,
): { readonly start: number; readonly end: number } => {
  if (widths.length === 0) return { start: 0, end: 0 };
  const cursor = Math.max(0, Math.min(active, widths.length - 1));
  let start = cursor;
  let end = cursor + 1;
  let used = widths[cursor]!;
  let takeRight = true;
  while (true) {
    const canRight =
      end < widths.length && used + gap + widths[end]! <= available;
    const canLeft = start > 0 && used + gap + widths[start - 1]! <= available;
    if (!canRight && !canLeft) break;
    if ((takeRight && canRight) || !canLeft) {
      used += gap + widths[end]!;
      end++;
    } else {
      start--;
      used += gap + widths[start]!;
    }
    takeRight = !takeRight;
  }
  return { start, end };
};

/**
 * Window for prompt lists that render "↑ N more"/"↓ N more" indicator rows:
 * reserves two of `visibleCount`'s rows for the indicators when overflowing so
 * the widget stays within the requested height.
 */
export const overflowListWindow = (
  length: number,
  cursor: number,
  visibleCount: number,
): { readonly start: number; readonly end: number } =>
  listWindow(
    length,
    cursor,
    Math.max(1, length > visibleCount ? visibleCount - 2 : visibleCount),
  );

/** Windowed list keeping `cursor` centered; each item renders as a block. */
type ViewportProps<Item> = {
  readonly items: ReadonlyArray<Item>;
  readonly cursor?: number;
  readonly height: number;
  readonly renderItem: (item: Item, index: number) => ReactNode;
  readonly getKey: (item: Item, index: number) => string;
  readonly empty?: ReactNode;
};

export function Viewport<Item>({
  items,
  cursor = 0,
  height,
  renderItem,
  getKey,
  empty,
}: ViewportProps<Item>) {
  if (items.length === 0) return <>{empty}</>;
  const selected = Math.max(0, Math.min(cursor, items.length - 1));
  const { start, end } = listWindow(
    items.length,
    selected,
    Math.max(1, height),
  );
  return (
    <Stack>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        return (
          <Box key={getKey(item, index)} flexDirection="column">
            {renderItem(item, index)}
          </Box>
        );
      })}
    </Stack>
  );
}
