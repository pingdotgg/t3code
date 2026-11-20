import { readAloudShownText } from "@t3tools/shared/read-aloud";
import { useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";
import type {
  HighlightLayoutEvent,
  RenderedTextChangeEvent,
  TextHighlight,
} from "react-native-enriched-markdown";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";
import { useReadAloudHighlight } from "./ReadAloudButton";
import { followReadAloud } from "./readAloudFollow";

/** The web's `--read-aloud-block` and `--read-aloud-word`: its info blue at these strengths. */
const READ_ALOUD_TINT = {
  light: { block: "rgba(59, 130, 246, 0.09)", word: "rgba(59, 130, 246, 0.32)" },
  dark: { block: "rgba(59, 130, 246, 0.22)", word: "rgba(59, 130, 246, 0.55)" },
};
const NO_HIGHLIGHTS: ReadonlyArray<TextHighlight> = [];

// Built on the first word read in a view, not for every reply on screen, and kept per render.
const locators = new WeakMap<
  RenderedTextChangeEvent,
  { readonly markdown: string; readonly locate: ReturnType<typeof readAloudShownText> }
>();
function locator(markdown: string, shown: RenderedTextChangeEvent) {
  const cached = locators.get(shown);
  if (cached?.markdown === markdown) return cached.locate;
  const locate = readAloudShownText(markdown, shown.text);
  locators.set(shown, { markdown, locate });
  return locate;
}

/**
 * Markdown of a reply that read aloud can read: tints the paragraph and word being read and keeps
 * the word in view. `readAloud.markdown` is the text read aloud reads, which can differ from the
 * part of it this view shows.
 */
export function ReadAloudMarkdownText(
  props: SelectableMarkdownTextProps & {
    readonly readAloud: { readonly id: string; readonly markdown: string };
  },
) {
  const { readAloud, ...markdownProps } = props;
  const highlight = useReadAloudHighlight(readAloud.id);
  const { themeAppearance } = useAppearancePreferences();
  const [shown, setShown] = useState<RenderedTextChangeEvent | null>(null);
  const container = useRef<ViewInstance>(null);
  const ranges = highlight && shown ? locator(readAloud.markdown, shown)(highlight) : null;
  // Code blocks and tables are tinted whole, so only the paragraph tint marks them.
  const opaque = shown?.blocks.find(
    (block) =>
      block.kind !== "text" &&
      ranges?.word &&
      ranges.word.start < block.end &&
      ranges.word.end > block.start,
  );
  const tint = READ_ALOUD_TINT[themeAppearance === "dark" ? "dark" : "light"];
  const highlights = ranges
    ? [
        ...(ranges.block ? [{ ...ranges.block, color: tint.block, borderRadius: 4 }] : []),
        ...(ranges.word && !opaque
          ? [{ ...ranges.word, color: tint.word, borderRadius: 4, padding: 1 }]
          : []),
      ]
    : NO_HIGHLIGHTS;
  const onHighlightLayout = ({ highlights: rects }: HighlightLayoutEvent) => {
    const target = rects.at(-1);
    if (!target) return;
    container.current?.measureInWindow((_x, y) =>
      followReadAloud(readAloud.id, { top: y + target.y, height: target.height }),
    );
  };
  return (
    <View ref={container} collapsable={false} style={{ flexShrink: 1, minWidth: 0 }}>
      <SelectableMarkdownText
        {...markdownProps}
        highlights={highlights}
        onRenderedTextChange={setShown}
        onHighlightLayout={onHighlightLayout}
      />
    </View>
  );
}
