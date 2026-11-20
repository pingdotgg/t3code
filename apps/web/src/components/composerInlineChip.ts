import { glyphSvgMarkup } from "../icons/glyphMarkup";
import { packageGlyph } from "../icons/glyphs.generated";

export const SKILL_CHIP_ICON_SVG = glyphSvgMarkup(packageGlyph, 'width="100%" height="100%"');

export function middleTruncateAttachmentName(name: string, maxCharacters = 36): string {
  const characters = Array.from(name);
  if (characters.length <= maxCharacters) return name;
  if (maxCharacters <= 0) return "";
  if (maxCharacters === 1) return "…";
  const available = maxCharacters - 1;
  const suffixLength = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
  const prefixLength = available - suffixLength;
  const suffix = suffixLength === 0 ? "" : characters.slice(-suffixLength).join("");
  return `${characters.slice(0, prefixLength).join("")}…${suffix}`;
}
