import { readAloudShownText } from "@t3tools/shared/read-aloud";
import { useRef, useState, useSyncExternalStore } from "react";
import { useGT } from "gt-react-native";
import { View, type ViewInstance } from "react-native";
import type {
  HighlightLayoutEvent,
  RenderedTextChangeEvent,
  TextHighlight,
} from "react-native-enriched-markdown";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";
import { alertReadAloudError, useReadAloudHighlight } from "./ReadAloudButton";
import { useReadAloudSettings } from "./useReadAloudSettings";
import { followReadAloud } from "./readAloudFollow";
import { readAloudSelectionSource, readAloudTapSource } from "./readAloudTap";
import { readAloudController } from "./playback";

/** The web's `--read-aloud-block` and `--read-aloud-word`: its info blue at these strengths. */
const READ_ALOUD_TINT = {
  light: { block: "rgba(59, 130, 246, 0.09)", word: "rgba(59, 130, 246, 0.32)" },
  dark: { block: "rgba(59, 130, 246, 0.22)", word: "rgba(59, 130, 246, 0.55)" },
};
const NO_HIGHLIGHTS: ReadonlyArray<TextHighlight> = [];

// Built on the first word read in a view, not for every reply on screen, and kept per render.
const locators = new WeakMap<
  RenderedTextChangeEvent,
  {
    readonly markdown: string;
    readonly math: boolean;
    readonly locate: ReturnType<typeof readAloudShownText>;
  }
>();
function locator(markdown: string, shown: RenderedTextChangeEvent, math: boolean) {
  const cached = locators.get(shown);
  if (cached?.markdown === markdown && cached.math === math) return cached.locate;
  const locate = readAloudShownText(markdown, shown.text, { math });
  locators.set(shown, { markdown, math, locate });
  return locate;
}

/**
 * A reply read aloud can read: tints what is read and keeps it in view; a tap reads from a word,
 * and a finished (`readable`) reply reads from a selection. `readAloud.markdown` is all the text
 * read, which can be more than this view shows.
 */
export function ReadAloudMarkdownText(
  props: SelectableMarkdownTextProps & {
    readonly readAloud: {
      readonly id: string;
      readonly markdown: string;
      readonly readable: boolean;
    };
  },
) {
  const { readAloud, ...markdownProps } = props;
  const settings = useReadAloudSettings();
  const highlight = useReadAloudHighlight(readAloud.id);
  const reading = useSyncExternalStore(readAloudController.subscribe, () =>
    readAloudController.isReading(readAloud.id),
  );
  const gt = useGT();
  const { themeAppearance, mathRenderingEnabled: math } = useAppearancePreferences();
  const [shown, setShown] = useState<RenderedTextChangeEvent | null>(null);
  const container = useRef<ViewInstance>(null);
  const ranges = highlight && shown ? locator(readAloud.markdown, shown, math)(highlight) : null;
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
        // Only while the reply is read, so taps elsewhere keep their native behavior.
        onTextPress={
          reading && shown
            ? (tap) => {
                const place = readAloudTapSource(readAloud.markdown, shown, tap, { math });
                const moved = !place
                  ? null
                  : place.word
                    ? readAloudController.seek(readAloud.id, place.from)
                    : readAloudController.jump(readAloud.id, place.from);
                void moved?.then(() =>
                  alertReadAloudError(readAloud.id, gt("Could not read aloud")),
                );
              }
            : undefined
        }
        onReadFromSelection={
          readAloud.readable && settings.provider !== "off" && shown
            ? (selection) => {
                const from = readAloudSelectionSource(readAloud.markdown, shown, selection, {
                  math,
                });
                void (
                  from === null
                    ? readAloudController.start(readAloud.id, readAloud.markdown, settings)
                    : readAloudController.start(readAloud.id, readAloud.markdown, settings, from)
                ).then(() => alertReadAloudError(readAloud.id, gt("Could not read aloud")));
              }
            : undefined
        }
        onRenderedTextChange={setShown}
        onHighlightLayout={onHighlightLayout}
      />
    </View>
  );
}
