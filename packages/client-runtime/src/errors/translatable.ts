import { decodeMsg, decodeOptions, mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import * as Schema from "effect/Schema";

/**
 * One or more `msg()` sentences shown together, joined by a space. Errors carry it beside
 * their English `message` so logs and English comparisons keep working.
 */
export type MarkedText = ReadonlyArray<string>;
export const MarkedText = Schema.Array(Schema.String);

function englishSentence(marked: string): string {
  return typeof decodeOptions(marked)?.$_source === "string" ? decodeMsg(marked) : marked;
}

export function markedTextEnglish(text: MarkedText): string {
  return text.map(englishSentence).join(" ");
}

export function resolveMarkedText(text: MarkedText, resolve: MFunctionType = mFallback): string {
  return text.map((sentence) => resolve(sentence)).join(" ");
}

/** `detail` in English plus the marked text, for errors whose `message` reads `detail`. */
export function translatableDetail(...text: MarkedText): {
  readonly detail: string;
  readonly i18nMessage: MarkedText;
} {
  return { detail: markedTextEnglish(text), i18nMessage: text };
}

/** `message` in English plus the marked text. */
export function translatableMessage(...text: MarkedText): {
  readonly message: string;
  readonly i18nMessage: MarkedText;
} {
  return { message: markedTextEnglish(text), i18nMessage: text };
}

export function errorI18nMessage(error: unknown): MarkedText | undefined {
  if (typeof error !== "object" || error === null || !("i18nMessage" in error)) return undefined;
  const text = error.i18nMessage;
  return Array.isArray(text) && text.every((sentence) => typeof sentence === "string")
    ? text
    : undefined;
}

/**
 * What to show for an error: its marked text in the active language when it has one,
 * otherwise its non-empty `message`, otherwise null.
 */
export function errorDisplayMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  const text = errorI18nMessage(error);
  if (text !== undefined) return resolveMarkedText(text, resolve);
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  return typeof error.message === "string" && error.message.trim().length > 0
    ? error.message
    : null;
}

/**
 * A thrown `Error`'s text in the active language, its plain `message` (even empty) when it has no
 * marked text, and null for anything that is not an `Error`.
 */
export function thrownErrorMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  if (!(error instanceof Error)) return null;
  const text = errorI18nMessage(error);
  return text === undefined ? error.message : resolveMarkedText(text, resolve);
}

/** Carries another error's message, and its marked text when it has one, into `detail`. */
export function detailFromError(error: { readonly message: string }): {
  readonly detail: string;
  readonly i18nMessage?: MarkedText;
} {
  const text = errorI18nMessage(error);
  return text === undefined
    ? { detail: error.message }
    : { detail: error.message, i18nMessage: text };
}

/** Carries another error's message, and its marked text when it has one, into `message`. */
export function messageFromError(error: { readonly message: string }): {
  readonly message: string;
  readonly i18nMessage?: MarkedText;
} {
  const text = errorI18nMessage(error);
  return text === undefined
    ? { message: error.message }
    : { message: error.message, i18nMessage: text };
}

/** A plain `Error` whose `message` stays English and that carries its marked text. */
export function translatableError(
  ...text: MarkedText
): Error & { readonly i18nMessage: MarkedText } {
  return Object.assign(new Error(markedTextEnglish(text)), { i18nMessage: text });
}

/**
 * Attaches marked text to an error whose class lives in `@t3tools/contracts`, so it cannot
 * declare the field. Use only when the error's `message` is exactly that text in English.
 */
export function withI18nMessage<E extends Error>(
  error: E,
  ...text: MarkedText
): E & { readonly i18nMessage: MarkedText } {
  return Object.assign(error, { i18nMessage: text });
}
