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
 * A small raster icon carried inline. The prefix is pinned to PNG rather than
 * any `data:image/`. On web that is what keeps an SVG, which can script, out
 * of the `<img>`, because Blink picks the decoder from the declared type. Mobile's
 * image library sniffs content instead, so there the guarantee is that neither
 * renderer in use has a script engine, not the prefix.
 *
 * Nothing past the signature is read, so this says nothing about frame count.
 * APNG carries the same signature and animates.
 *
 * The first pattern spells out whole base64 quartets rather than a run of
 * characters and loose padding. That refuses the three in four truncations
 * that stop mid-quartet. One that stops on a quartet boundary still decodes,
 * to a PNG carrying a signature and no pixels, and reaches the renderer.
 *
 * The second is the PNG signature, which base64 fixes to `iVBORw0KGg` for any
 * PNG whatever its ninth byte. Checking the encoded prefix costs nothing on a
 * path that decodes settings for every connected client on every change, and it
 * means the declared type is the writer's claim while this is the evidence.
 */
export const IconImageDataUrl = Schema.String.check(
  Schema.isMaxLength(ICON_IMAGE_DATA_URL_MAX_LENGTH),
  Schema.isPattern(
    /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/,
  ),
  Schema.isPattern(/^data:image\/png;base64,iVBORw0KGg/),
);
export type IconImageDataUrl = typeof IconImageDataUrl.Type;
