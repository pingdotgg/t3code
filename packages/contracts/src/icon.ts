import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Leaf schemas shared by every user-chosen icon (project overrides and
 * environment overrides). The composite override shapes differ per owner and
 * live beside the owner; only the pieces that must agree across them live here.
 */

export const IconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type IconColor = typeof IconColor.Type;

/** A Lucide icon id, or any curated id that follows the same kebab-case grammar. */
export const LucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type LucideIconName = typeof LucideIconName.Type;

export const IconEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type IconEmoji = typeof IconEmoji.Type;

// Grapheme-count validation belongs to the write boundary, not snapshot decoding.
export const MonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);
export type MonogramText = typeof MonogramText.Type;

/**
 * Whether `text` reads as at most two characters, the bound a monogram tile
 * can hold. The count is code points after stripping the combining marks and
 * joiners `MonogramText` admits, which matches grapheme counting for Latin,
 * digits, and accents either precomposed or decomposed. A Devanagari conjunct
 * or a decomposed Hangul syllable counts high, so those scripts get one
 * cluster rather than two.
 *
 * `Intl.Segmenter` would be exact, and Hermes does not ship it. Reaching for
 * it where it exists would accept on the server and on web what mobile
 * refuses, and one bound every client computes the same way is worth more
 * than the extra scripts.
 */
export function isMonogramLength(text: string): boolean {
  return Array.from(text.replace(/[\p{M}\u200c\u200d]/gu, "")).length <= 2;
}

/**
 * Encoded length budget for an inline raster icon. A 64 by 64 PNG with alpha
 * is at most 16 KiB of pixels before compression, which base64 grows by a
 * third; the cap leaves room for the container without admitting a photo.
 */
export const ICON_IMAGE_DATA_URL_MAX_LENGTH = 32_768;

/**
 * Largest width or height an inline icon may declare. Both pickers write 64 by
 * 64; the cap leaves room for an encoder working at a display scale while
 * holding a decoded icon to 256 KiB on every client that draws it.
 */
const ICON_IMAGE_MAX_EDGE = 256;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
// The eight byte signature, then the first chunk: length 13, type "IHDR".
const PNG_HEADER_START = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
];

/**
 * Whether a PNG data URL opens with the signature and an IHDR chunk whose
 * width and height are within `ICON_IMAGE_MAX_EDGE`. Decodes only the first
 * 24 bytes, which is where PNG fixes those fields.
 */
function hasIconPngHeader(dataUrl: string): boolean {
  const head = dataUrl.slice(PNG_DATA_URL_PREFIX.length, PNG_DATA_URL_PREFIX.length + 32);
  const bytes = Result.getOrNull(Base64.decode(head));
  if (bytes === null || bytes.length < 24) return false;
  if (PNG_HEADER_START.some((byte, index) => bytes[index] !== byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width <= ICON_IMAGE_MAX_EDGE && height <= ICON_IMAGE_MAX_EDGE;
}

/**
 * A small raster icon carried inline. The prefix is pinned to PNG rather than
 * any `data:image/`. On web that is what keeps an SVG, which can script, out
 * of the `<img>`, because Blink picks the decoder from the declared type. Mobile's
 * image library sniffs content instead, so there the guarantee is that neither
 * renderer in use has a script engine, not the prefix.
 *
 * The pattern spells out whole base64 quartets rather than a run of characters
 * and loose padding. That refuses the three in four truncations that stop
 * mid-quartet.
 *
 * The header check backs the declared type and bounds the pixels, which the
 * length cap cannot, since a large flat image compresses to almost nothing.
 * It reads nothing past IHDR, so an animated PNG passes.
 */
export const IconImageDataUrl = Schema.String.check(
  Schema.isMaxLength(ICON_IMAGE_DATA_URL_MAX_LENGTH),
  Schema.isPattern(
    /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/,
  ),
  Schema.makeFilter(hasIconPngHeader),
);
export type IconImageDataUrl = typeof IconImageDataUrl.Type;
