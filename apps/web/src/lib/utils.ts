import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expandQueryAcrossKeyboardLayouts } from "@t3tools/shared/keyboardLayouts";
import { type CxOptions, cx } from "class-variance-authority";
import * as Encoding from "effect/Encoding";
import { twMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface SearchQueryForm {
  readonly normalizedQuery: string;
  readonly queryTokens: ReadonlyArray<string>;
  /** Subtracted from this form's rank; zero for the form that was typed. */
  readonly rankPenalty: number;
}

/**
 * What was typed, first, followed by the keyboard layout variants of it, so a
 * query typed while a non-Latin layout was active still reaches Latin names.
 * Callers rank an item by the first form it matches and subtract that form's
 * `rankPenalty`, which keeps every direct match ahead of every mapped one as
 * long as `layoutRankPenalty` exceeds the spread of the caller's rank scale.
 *
 * Variants come off the raw query, because `normalizeSearchText` applies NFKD
 * and strips combining marks, which destroys `й` and `ё`.
 */
export function buildSearchQueryForms(input: {
  query: string;
  normalizedQuery: string;
  layoutRankPenalty: number;
}): ReadonlyArray<SearchQueryForm> {
  return [
    {
      normalizedQuery: input.normalizedQuery,
      queryTokens: input.normalizedQuery.split(" "),
      rankPenalty: 0,
    },
    ...expandQueryAcrossKeyboardLayouts(input.query).flatMap((variant) => {
      const normalizedVariant = normalizeSearchText(variant);
      return normalizedVariant.length === 0
        ? []
        : [
            {
              normalizedQuery: normalizedVariant,
              queryTokens: normalizedVariant.split(" "),
              rankPenalty: input.layoutRankPenalty,
            },
          ];
    }),
  ];
}

export function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "File Explorer";
  }
  return "Files";
}

export function randomHex(byteLength: number): string {
  return Encoding.encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
