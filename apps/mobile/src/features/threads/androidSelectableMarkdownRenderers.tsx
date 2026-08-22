import type { ReactNode } from "react";
import { Text as NativeText, type TextStyle } from "react-native";
import { TaskListItem, type CustomRenderers, type MarkdownNode } from "react-native-nitro-markdown";

export interface AndroidSelectableMarkdownRendererStyles {
  readonly paragraph: TextStyle;
  readonly heading: (level: number) => TextStyle;
  /** Text runs directly inside list items (tight lists); no block margins. */
  readonly listItemText: TextStyle;
}

type RendererComponent = Parameters<NonNullable<CustomRenderers["paragraph"]>>[0]["Renderer"];

/**
 * Mirrors the library's isInline, minus math_inline. MathInline renders a View,
 * and outside headings the library deliberately groups it in a row View rather
 * than nesting it under Text, so it must not join a selectable run.
 */
const SELECTABLE_INLINE_NODE_TYPES = new Set<MarkdownNode["type"]>([
  "text",
  "bold",
  "italic",
  "strikethrough",
  "link",
  "code_inline",
  "soft_break",
  "line_break",
  "html_inline",
]);

/**
 * Children the library renders as views (images, math) cannot move inside a
 * selectable Text: on Android that is invalid Text -> View nesting and the node
 * fails to lay out. Renderers return undefined for those nodes, which hands
 * them back to the library's own rendering path.
 */
function hasNonSelectableChild(node: MarkdownNode): boolean {
  return (node.children ?? []).some((child) => !SELECTABLE_INLINE_NODE_TYPES.has(child.type));
}

/** List items already render block children outside the run; only math is unsafe. */
function hasMathInlineChild(node: MarkdownNode): boolean {
  return (node.children ?? []).some((child) => child.type === "math_inline");
}

function childKey(child: MarkdownNode, index: number): string {
  return `${child.type}:${child.beg ?? index}:${child.end ?? index}`;
}

function renderInlineChildren(node: MarkdownNode, Renderer: RendererComponent): ReactNode {
  return node.children?.map((child, index) => (
    <Renderer key={childKey(child, index)} node={child} depth={1} inListItem={false} parentIsText />
  ));
}

/**
 * Renders a node's children the way the library's renderChildren does, except
 * each consecutive inline run is wrapped in a selectable native Text. Block
 * children (nested lists, paragraphs) re-enter the library renderer so these
 * overrides keep applying recursively.
 */
function renderSelectableChildren(
  node: MarkdownNode,
  Renderer: RendererComponent,
  textStyle: TextStyle,
): ReactNode[] {
  const children = node.children ?? [];
  const output: ReactNode[] = [];
  let inlineRun: { child: MarkdownNode; index: number }[] = [];

  const flushInlineRun = () => {
    if (inlineRun.length === 0) return;
    const first = inlineRun[0]!;
    output.push(
      <NativeText selectable style={textStyle} key={`run:${childKey(first.child, first.index)}`}>
        {inlineRun.map(({ child, index }) => (
          <Renderer
            key={childKey(child, index)}
            node={child}
            depth={1}
            inListItem={false}
            parentIsText
          />
        ))}
      </NativeText>,
    );
    inlineRun = [];
  };

  children.forEach((child, index) => {
    if (SELECTABLE_INLINE_NODE_TYPES.has(child.type)) {
      inlineRun.push({ child, index });
      return;
    }
    flushInlineRun();
    output.push(
      <Renderer
        key={childKey(child, index)}
        node={child}
        depth={1}
        inListItem
        parentIsText={false}
      />,
    );
  });
  flushInlineRun();

  return output;
}

export interface AndroidSelectableHeadingStyleInput {
  /** The same sizes handed to the markdown theme's fontSizes. */
  readonly fontSizes: Readonly<Record<"h1" | "h2" | "h3" | "h4" | "h5" | "h6", number>>;
  /** theme.colors.border, drawn as the rule under level-one headings. */
  readonly borderColor: string;
  /** theme.spacing.s, the gap between a level-one heading and its rule. */
  readonly borderSpacing: number;
  /** The heading node style override, applied last exactly as the library does. */
  readonly override: TextStyle | undefined;
}

const HEADING_LETTER_SPACING: Readonly<Record<number, number>> = { 1: -0.6, 2: -0.4 };
const HEADING_LINE_HEIGHT_RATIO = 1.3;

function headingFontSizeKey(level: number): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  switch (level) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    default:
      return "h6";
  }
}

/**
 * Rebuilds Nitro Markdown's Heading styling for the selectable replacement:
 * per-level size, line height and letter spacing, Android font padding, and the
 * rule under level-one headings. Taking over the heading renderer without this
 * silently drops that decoration. Heading weight matches the theme's
 * headingWeight, which the thread feed pins to "700".
 */
export function createAndroidSelectableHeadingStyle(
  input: AndroidSelectableHeadingStyleInput,
): (level: number) => TextStyle {
  return (level) => {
    const fontSize = input.fontSizes[headingFontSizeKey(level)];
    return {
      fontWeight: "700",
      fontSize,
      lineHeight: fontSize * HEADING_LINE_HEIGHT_RATIO,
      letterSpacing: HEADING_LETTER_SPACING[level] ?? -0.2,
      includeFontPadding: false,
      ...(level === 1
        ? {
            borderBottomWidth: 1,
            borderBottomColor: input.borderColor,
            paddingBottom: input.borderSpacing,
          }
        : null),
      ...input.override,
    };
  };
}

export function createAndroidSelectableMarkdownRenderers(
  styles: AndroidSelectableMarkdownRendererStyles,
): Pick<CustomRenderers, "heading" | "paragraph" | "list_item" | "task_list_item"> {
  return {
    paragraph: ({ node, Renderer }) => {
      if (hasNonSelectableChild(node)) return undefined;
      return (
        <NativeText selectable style={styles.paragraph}>
          {renderInlineChildren(node, Renderer)}
        </NativeText>
      );
    },
    // The library already renders every heading child under a Text, so images
    // and math keep whatever behaviour they had before selection was added.
    heading: ({ node, Renderer, level = 1 }) => (
      <NativeText selectable style={styles.heading(level)}>
        {renderInlineChildren(node, Renderer)}
      </NativeText>
    ),
    // Tight-list items hold inline nodes directly (no paragraph wrapper), which
    // the library wraps in a non-selectable Text. Bullet markers are drawn by
    // the parent list renderer, so this only owns the item's content.
    list_item: ({ node, Renderer }) => {
      if (hasMathInlineChild(node)) return undefined;
      return <>{renderSelectableChildren(node, Renderer, styles.listItemText)}</>;
    },
    task_list_item: ({ node, Renderer, checked = false }) => {
      if (hasMathInlineChild(node)) return undefined;
      return (
        <TaskListItem checked={checked}>
          {renderSelectableChildren(node, Renderer, styles.listItemText)}
        </TaskListItem>
      );
    },
  };
}
