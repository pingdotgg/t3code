import type { SpeakEmoji } from "@t3tools/shared/read-aloud";

const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
// Presentation selectors and skin tones do not change an emoji's name.
const VARIANT = /[️\u{1F3FB}-\u{1F3FF}]/gu;

let names: Promise<SpeakEmoji> | null = null;

/**
 * Names emoji the way screen readers do, by their Unicode CLDR short names ("thumbs up"). The
 * names load only for a reply that has emoji, so others start reading in the same turn.
 */
export function prepareReadAloudEmoji(markdown: string): Promise<SpeakEmoji> | undefined {
  if (!HAS_EMOJI.test(markdown)) return undefined;
  names ??= import("emojibase-data/en/shortcodes/cldr.json").then((module) => {
    const shortcodes: Readonly<Record<string, string | ReadonlyArray<string>>> = module.default;
    const nameOf = (emoji: string) => {
      const hexcode = Array.from(emoji, (character) =>
        character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"),
      ).join("-");
      const shortcode = shortcodes[hexcode];
      return (Array.isArray(shortcode) ? shortcode[0] : shortcode)?.replaceAll("_", " ");
    };
    return (emoji) => nameOf(emoji.replace(VARIANT, "")) ?? nameOf(emoji);
  });
  names.catch(() => {
    names = null;
  });
  return names;
}
