import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isPlainObject } from "./data.ts";

/**
 * Removing secrets from text that may echo them: API error bodies, Helm
 * stderr, command output. Secrets come from the `Redacted` values a caller
 * sent; each is matched raw, base64-encoded and JSON-escaped, since those are
 * the forms an echo usually takes.
 */

/** Marker written in place of a secret unless a caller picks another. */
export const DEFAULT_REDACTION_MARKER = "<redacted>";

/**
 * Plaintext strings wrapped in {@link Redacted} anywhere in `value`, including
 * strings nested inside a redacted object or array. Plain values are ignored.
 */
export const collectRedactedSecrets = (value: unknown): string[] => {
  const out: string[] = [];
  const visit = (current: unknown, sensitive: boolean): void => {
    if (Redacted.isRedacted(current)) {
      visit(Redacted.value(current), true);
      return;
    }

    if (typeof current === "number") {
      if (!sensitive) return;
      const text = String(current);
      if (text.length === 0) return;
      out.push(text);
      return;
    }

    if (typeof current === "string") {
      if (!sensitive || current.length === 0) return;
      out.push(current);
      // Env values are strings, so a redacted object arrives as JSON.
      // Parse it so an echoed inner secret still scrubs.
      const head = current.charCodeAt(0);
      if (head !== 123 && head !== 91) return;
      try {
        const parsed: unknown = JSON.parse(current);
        if (parsed !== null && typeof parsed === "object") visit(parsed, true);
      } catch {
        // Not JSON. The string itself is the secret.
      }
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) visit(item, sensitive);
      return;
    }

    if (isPlainObject(current)) {
      for (const item of Object.values(current)) visit(item, sensitive);
    }
  };

  visit(value, false);
  return [...new Set(out)];
};

/** The forms a secret is echoed in: raw, base64, and JSON-escaped. */
const secretForms = (secret: string): string[] => [
  ...new Set(
    [secret, Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1)].filter(
      (form) => form.length > 0,
    ),
  ),
];

/**
 * A marker that cannot reproduce any secret: `preferred`, unless a secret
 * appears inside it, then a private-use character absent from every secret.
 */
export const redactionMarker = (
  secrets: ReadonlyArray<string>,
  preferred: string = DEFAULT_REDACTION_MARKER,
): string => {
  if (!secrets.some((secret) => preferred.includes(secret))) return preferred;
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate))) return candidate;
  }
  for (let codePoint = 0xf0000; codePoint <= 0xffffd; codePoint++) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate))) return candidate;
  }
  // Only a secret larger than the private-use space gets here. An empty
  // replacement is safer than reproducing any part of it.
  return "";
};

// Secrets shorter than 4 characters only match whole tokens, so "42" does not
// eat "14293". Longer secrets match anywhere (`printf "prefix%ssuffix"`).
const SHORT_SECRET_LENGTH = 4;

const replaceForm = (text: string, form: string, anywhere: boolean, marker: string): string => {
  if (form.length === 0 || !text.includes(form)) return text;
  if (anywhere) return text.replaceAll(form, marker);
  const pattern = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])${pattern}(?![A-Za-z0-9_])`, "g"), marker);
};

/** Replace every form of every secret in plain text with `marker`. */
export const redactText = (
  text: string,
  secrets: ReadonlyArray<string>,
  marker: string = DEFAULT_REDACTION_MARKER,
): string => {
  if (secrets.length === 0 || text.length === 0) return text;
  // One secret can be a prefix of another. Replace the longest form first or
  // the shorter one splits the longer one and leaves its suffix behind.
  const forms = new Map<string, boolean>();
  for (const secret of secrets) {
    const anywhere = secret.length >= SHORT_SECRET_LENGTH;
    for (const form of secretForms(secret)) {
      forms.set(form, forms.get(form) === true || anywhere);
    }
  }
  const ordered = [...forms.entries()].sort((left, right) => right[0].length - left[0].length);
  let out = text;
  for (const [form, anywhere] of ordered) out = replaceForm(out, form, anywhere, marker);
  return out;
};

const redactNode = (value: unknown, secrets: ReadonlyArray<string>, marker: string): unknown => {
  if (typeof value === "string") return redactText(value, secrets, marker);
  if (typeof value === "number" && secrets.some((secret) => secret === String(value))) {
    return marker;
  }
  if (Array.isArray(value)) return value.map((item) => redactNode(item, secrets, marker));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactNode(child, secrets, marker)]),
    );
  }
  return value;
};

/**
 * Like {@link redactText}, but a JSON document is redacted leaf by leaf, so a
 * secret that only appears JSON-escaped inside a string is still caught.
 * Text that is not JSON falls back to {@link redactText}.
 */
export const redactJson = (
  text: string,
  secrets: ReadonlyArray<string>,
  marker: string = DEFAULT_REDACTION_MARKER,
): string => {
  if (secrets.length === 0 || text.length === 0) return text;
  try {
    return JSON.stringify(redactNode(JSON.parse(text), secrets, marker));
  } catch {
    return redactText(text, secrets, marker);
  }
};

/**
 * Redact a text stream without leaking a secret split across chunks. Every
 * form of every secret matches as a substring; the earliest match wins, and
 * the longest form wins a tie. A match is only replaced once no form starting
 * at or before it can still grow in the next chunk, so the output does not
 * depend on where the chunks split.
 */
export const redactStream = <E, R>(
  stream: Stream.Stream<string, E, R>,
  secrets: ReadonlyArray<string>,
  marker: string = DEFAULT_REDACTION_MARKER,
): Stream.Stream<string, E, R> => {
  const forms = [...new Set(secrets.flatMap(secretForms))].sort(
    (left, right) => right.length - left.length,
  );
  if (forms.length === 0) return stream;

  // Split `text` into redacted output and the pending suffix still held back.
  // At the end of the stream nothing can grow, so nothing is held back.
  const scan = (text: string, final: boolean): readonly [pending: string, output: string] => {
    let remaining = text;
    let output = "";

    while (remaining.length > 0) {
      let matchIndex = -1;
      let match: string | undefined;
      for (const form of forms) {
        const index = remaining.indexOf(form);
        if (
          index >= 0 &&
          (matchIndex < 0 ||
            index < matchIndex ||
            (index === matchIndex && form.length > (match?.length ?? 0)))
        ) {
          matchIndex = index;
          match = form;
        }
      }

      // The longest suffix that is a proper prefix of some form.
      let suffixLength = 0;
      if (!final) {
        for (const form of forms) {
          const candidateLength = Math.min(form.length - 1, remaining.length);
          for (let length = candidateLength; length > suffixLength; length--) {
            if (form.startsWith(remaining.slice(-length))) {
              suffixLength = length;
              break;
            }
          }
        }
      }
      const pendingIndex = remaining.length - suffixLength;

      // A form that may still complete at or before the match would win
      // over it, so wait for more text before deciding.
      if (match !== undefined && (suffixLength === 0 || matchIndex < pendingIndex)) {
        output += remaining.slice(0, matchIndex) + marker;
        remaining = remaining.slice(matchIndex + match.length);
        continue;
      }

      output += remaining.slice(0, pendingIndex);
      remaining = remaining.slice(pendingIndex);
      break;
    }

    return [remaining, output] as const;
  };

  return stream.pipe(
    Stream.mapAccum(
      () => "",
      (pending, chunk) => {
        const [remaining, output] = scan(pending + chunk, false);
        return [remaining, output.length === 0 ? [] : [output]] as const;
      },
      {
        onHalt: (pending) => {
          const [, output] = scan(pending, true);
          return output.length === 0 ? [] : [output];
        },
      },
    ),
  );
};
