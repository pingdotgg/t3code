import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  ComposerContextClipboardFragment,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { COMPOSER_CONTEXT_CLIPBOARD_MIME };

const MAX_FRAGMENT_CHARS = 16_000_000;
const decodeFragment = Schema.decodeUnknownOption(ComposerContextClipboardFragment);

export function encodeComposerContextFragment(
  fragment: ComposerContextClipboardFragment,
): string | null {
  const encoded = JSON.stringify(fragment);
  return encoded.length <= MAX_FRAGMENT_CHARS ? encoded : null;
}

/** HTML is the portable flavor shared by browsers and native system clipboards. */
export function encodeComposerContextClipboardHtml(
  text: string,
  fragment: string,
  html?: string,
): string {
  if (html !== undefined)
    return `<div data-t3-context-fragment="${encodeURIComponent(fragment)}">${html}</div>`;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre data-t3-context-fragment="${encodeURIComponent(fragment)}">${escaped}</pre>`;
}

export function decodeComposerContextClipboardHtml(
  html: string | null | undefined,
): ComposerContextClipboardFragment | null {
  if (!html || html.length > MAX_FRAGMENT_CHARS * 4) return null;
  const encoded = /data-t3-context-fragment=["']([^"']+)["']/.exec(html)?.[1];
  if (!encoded) return null;
  try {
    return decodeComposerContextFragment(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

/** Clipboard data is untrusted: anything that is not a valid version-1 fragment is ignored. */
export function decodeComposerContextFragment(
  raw: string | null | undefined,
): ComposerContextClipboardFragment | null {
  if (!raw || raw.length > MAX_FRAGMENT_CHARS) return null;
  try {
    return Option.getOrNull(decodeFragment(JSON.parse(raw)));
  } catch {
    return null;
  }
}
