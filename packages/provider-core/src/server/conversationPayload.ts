const BINARY_OMITTED = "[binary payload omitted]";
const BINARY_TYPES = new Set([
  "image",
  "audio",
  "document",
  "file",
  "input_image",
  "input_audio",
  "input_file",
  "output_audio",
  "base64",
  "Buffer",
]);
const BINARY_FIELDS = new Set(["data", "blob", "bytes", "base64", "file_data"]);
const BINARY_CONTAINERS = new Set(["source", "input_audio", "inlineData", "inline_data", "file"]);
const CONTROL_CHARACTERS = /[\0-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/;
const BINARY_CHARACTER = /[\0-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\uFFFD]/;
const BINARY_CHARACTERS = new RegExp(BINARY_CHARACTER.source, "g");
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodesToText(base64: string): boolean {
  try {
    return !BINARY_CHARACTER.test(UTF8.decode(Buffer.from(base64, "base64")));
  } catch {
    return false;
  }
}

function isTextMediaType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:text\/|(?:application\/(?:json|xml|javascript|ecmascript)|[^;]+\+(?:json|xml))(?:;|$))/i.test(
      value,
    )
  );
}

function omitDataUrl(url: string, metadata: string, body: string): string {
  if (body.length <= BINARY_OMITTED.length) return url;
  const mime = metadata.split(";")[0]!;
  const base64 =
    /;base64(?:;|$)/i.test(metadata) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(body) &&
    body.length % 4 !== 1 &&
    !decodesToText(body);
  const binaryEscapes =
    mime !== "" && !isTextMediaType(mime) && /%[0-9a-f]{2}/i.test(body) && !body.includes("${");
  return base64 || binaryEscapes ? BINARY_OMITTED : url;
}

function omitBase64Token(token: string): string {
  const compact = token.replace(/\s/g, "");
  if (
    compact.length < 4096 ||
    compact.length % 4 === 1 ||
    !/[a-z]/.test(compact) ||
    !/[A-Z]/.test(compact) ||
    !/\d/.test(compact) ||
    !/[+/_=-]/.test(compact)
  )
    return token;
  const distinct = new Set<string>();
  for (const character of compact) {
    distinct.add(character);
    if (distinct.size >= 8) return decodesToText(compact) ? token : BINARY_OMITTED;
  }
  return token;
}

function omitBinaryLines(text: string): string {
  if (!CONTROL_CHARACTERS.test(text)) return text;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if ((line.match(BINARY_CHARACTERS)?.length ?? 0) <= line.length / 10) lines.push(line);
    else if (lines.at(-1) !== BINARY_OMITTED) lines.push(BINARY_OMITTED);
  }
  return lines.join("\n");
}

function omitBase64Text(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let start = 0; start < lines.length;) {
    let end = start;
    while (end < lines.length && /^[A-Za-z0-9+/_=-]+\r?$/.test(lines[end]!)) {
      const length = lines[end]!.replace(/\r$/, "").length;
      if (length < 64) break;
      end++;
    }
    if (end - start < 2) {
      output.push(
        lines[start++]!.replace(/[A-Za-z0-9+/_=-]+/g, (token) =>
          token.length < 4096 ? token : omitBase64Token(token),
        ),
      );
      continue;
    }
    if (end < lines.length && /^[A-Za-z0-9+/_=-]*\r?$/.test(lines[end]!)) end++;
    // A wrapped line can split a UTF-8 character; classify the complete block only once.
    output.push(omitBase64Token(lines.slice(start, end).join("\n")));
    start = end;
  }
  return output.join("\n");
}

function omitEncodedText(text: string): string {
  return omitBase64Text(
    omitBinaryLines(text).replace(
      /\bdata:((?:[\w.+-]+\/[\w.+-]+)?(?:;[^,\s"'<>]*)?),([^\s"'<>\x60)\]\\]+)/gi,
      omitDataUrl,
    ),
  );
}

export function omitConversationPayloads(value: unknown): unknown {
  let result: unknown;
  const pending: Array<() => void> = [];
  function enqueue(current: unknown, assign: (value: unknown) => void, binary = false): void {
    pending.push(() => {
      if (typeof current === "string") {
        const trimmed = current.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          let parsed: unknown;
          try {
            // Preserve numeric lexemes: parsing evidence must not round IDs or turn overflow into null.
            parsed = JSON.parse(current, (_key, entry: unknown, context) =>
              typeof entry === "number" && context?.source !== undefined
                ? JSON.rawJSON(context.source)
                : entry,
            );
          } catch {
            assign(omitEncodedText(current));
            return;
          }
          let sanitized: unknown;
          pending.push(() => {
            const serialized = JSON.stringify(sanitized);
            assign(serialized === JSON.stringify(parsed) ? current : serialized);
          });
          enqueue(
            parsed,
            (next) => {
              sanitized = next;
            },
            binary,
          );
          return;
        }
        assign(omitEncodedText(current));
        return;
      }
      if (current === null || typeof current !== "object" || JSON.isRawJSON(current)) {
        assign(current);
        return;
      }
      if (Array.isArray(current)) {
        const entries: unknown[] = new Array(current.length);
        assign(entries);
        for (let index = current.length - 1; index >= 0; index--) {
          enqueue(current[index], (next) => {
            entries[index] = next;
          });
        }
        return;
      }
      const record = current as Record<string, unknown>;
      const encoded =
        record.encoding === "base64" || record.type === "base64" || record.type === "Buffer";
      const textMime = isTextMediaType(record.mimeType ?? record.media_type ?? record.mime_type);
      const binaryBody =
        encoded ||
        (!textMime &&
          (binary ||
            (typeof record.type === "string" && BINARY_TYPES.has(record.type)) ||
            typeof record.mimeType === "string" ||
            typeof record.media_type === "string" ||
            typeof record.mime_type === "string"));
      const entries = Object.entries(record);
      const filtered: Record<string, unknown> = Object.fromEntries(entries);
      assign(filtered);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, entry] = entries[index]!;
        const payloadField =
          (binaryBody && BINARY_FIELDS.has(key)) ||
          key === "file_data" ||
          key === "image_base64" ||
          key === "audio_base64" ||
          (binaryBody && typeof entry === "string" && /^data:[^\s,]*,/i.test(entry)) ||
          (key === "blob" && typeof record.uri === "string");
        const payload =
          payloadField &&
          (typeof entry === "string" ||
            (Array.isArray(entry) &&
              entry.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)));
        if (payload) {
          filtered[key] = BINARY_OMITTED;
        } else {
          enqueue(
            entry,
            (next) => {
              filtered[key] = next;
            },
            binaryBody && BINARY_CONTAINERS.has(key),
          );
        }
      }
    });
  }
  enqueue(value, (next) => {
    result = next;
  });
  while (pending.length > 0) pending.pop()!();
  return result;
}

export function conversationEvidenceText(text: string): string {
  return omitConversationPayloads(text) as string;
}
