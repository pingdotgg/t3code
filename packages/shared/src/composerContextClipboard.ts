import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  ComposerContextClipboardFragment,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  formatComposerContextReference,
  threadContextRecord,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";
import { parseThreadDeepLink } from "./threadDeepLinks.ts";

export { COMPOSER_CONTEXT_CLIPBOARD_MIME };

/** Normalize public URLs before filtering clipboard records, including plain-text-only pastes. */
export function normalizeThreadClipboard(
  text: string,
  fragment: ComposerContextClipboardFragment | null,
  acceptedIds?: ReadonlyMap<string, string>,
) {
  const records = [...(fragment?.records ?? [])];
  let source = fragment?.source;
  // Skip code spans/fences and consume Markdown links as a unit to avoid nesting references.
  const normalized = text.replace(
    /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?\2|\[([^\]\n]*)\]\((https:\/\/app\.t3\.codes\/[^\s)]+|t3code(?:-dev|-preview)?:\/\/threads\/[^\s)]+)\)|<?(?:https:\/\/app\.t3\.codes\/|t3code(?:-dev|-preview)?:\/\/threads\/)[^\s<>`]+>?/g,
    (value, fence, span, label, href) => {
      if (fence || span) return value;
      const ref = parseThreadDeepLink(href ?? value.replace(/^<|>$/g, ""));
      if (!ref) return value;
      const existing = records.find(
        (record) =>
          record.kind === "thread" &&
          !("payload" in record) &&
          record.environmentId === ref.environmentId &&
          record.threadId === ref.threadId,
      );
      let record = existing ?? threadContextRecord(ref, label || ref.threadId);
      if (!existing && records.some((candidate) => candidate.contextId === record.contextId)) {
        record = {
          ...record,
          contextId: toKindScopedComposerContextId(
            "thread",
            ref.environmentId + "/" + ref.threadId,
          ),
        };
      }
      if (acceptedIds && !acceptedIds.has(record.contextId)) return value;
      if (!existing) records.push(record);
      source ??= { environmentId: ref.environmentId };
      return formatComposerContextReference(record);
    },
  );
  return {
    text: normalized,
    fragment: source ? { version: 1 as const, source, records } : fragment,
  };
}

const MAX_FRAGMENT_CHARS = 16_000_000;
const decodeFragment = Schema.decodeUnknownOption(ComposerContextClipboardFragment);

export function encodeComposerContextFragment(
  fragment: ComposerContextClipboardFragment,
): string | null {
  const encoded = JSON.stringify(fragment);
  return encoded.length <= MAX_FRAGMENT_CHARS ? encoded : null;
}

const HTML_WRAPPER_SLACK_CHARS = 4096;

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
  // Percent encoding can expand each UTF-16 code unit to nine characters.
  if (!html || html.length > MAX_FRAGMENT_CHARS * 9 + HTML_WRAPPER_SLACK_CHARS) return null;
  // `encodeURIComponent` leaves `'` as is, so each quote style must end only at its own quote.
  const match = /data-t3-context-fragment=(?:"([^"]+)"|'([^']+)')/.exec(html);
  const encoded = match?.[1] ?? match?.[2];
  if (!encoded) return null;
  try {
    return decodeComposerContextFragment(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

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
