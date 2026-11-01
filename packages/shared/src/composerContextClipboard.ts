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
  if (!text.includes("app.t3.codes/") && !text.includes("://threads/")) return { text, fragment };
  const records = [...(fragment?.records ?? [])];
  const byThread = new Map(
    records.flatMap((record) =>
      record.kind === "thread" && !("payload" in record)
        ? [[JSON.stringify([record.environmentId, record.threadId]), record] as const]
        : [],
    ),
  );
  const ids = new Set(records.map((record) => record.contextId));
  let source = fragment?.source;
  // Consume code and every Markdown link as a unit; never rewrite a URL inside another link.
  const normalized = text.replace(
    /(?<fence>`{3,}|~{3,})[\s\S]*?(?:\k<fence>|$)|(?<span>`+)[^\n]*?\k<span>|!?\[(?<label>(?:\\.|[^\]\\\n]){0,512})\]\((?<href>[^\s)]{1,4096})\)|(?<![\w/:=?&.-])(?<bare><(?:https:\/\/app\.t3\.codes\/|t3code(?:-dev|-preview)?:\/\/threads\/)[^\s<>`]+>|(?:https:\/\/app\.t3\.codes\/|t3code(?:-dev|-preview)?:\/\/threads\/)[^\s<>`]+)/g,
    (value, ...args) => {
      const groups = args.at(-1) as {
        fence?: string;
        span?: string;
        label?: string;
        href?: string;
        bare?: string;
      };
      if (groups.fence || groups.span || value.startsWith("![")) return value;
      const candidate = groups.href ?? groups.bare;
      if (!candidate) return value;
      const punctuation =
        groups.bare && !candidate.startsWith("<")
          ? (candidate.match(/[.,;:!?)\]\x27\x22]+$/)?.[0] ?? "")
          : "";
      const address = punctuation ? candidate.slice(0, -punctuation.length) : candidate;
      const ref = parseThreadDeepLink(address.replace(/^<|>$/g, ""));
      if (!ref) return value;
      const key = JSON.stringify([ref.environmentId, ref.threadId]);
      let record = byThread.get(key);
      if (!record) {
        record = threadContextRecord(ref, groups.label || ref.threadId);
        if (ids.has(record.contextId))
          record = { ...record, contextId: toKindScopedComposerContextId("thread", key) };
        records.push(record);
        ids.add(record.contextId);
        byThread.set(key, record);
      }
      if (acceptedIds && !acceptedIds.has(record.contextId)) return value;
      source ??= { environmentId: ref.environmentId };
      return formatComposerContextReference(record) + punctuation;
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
