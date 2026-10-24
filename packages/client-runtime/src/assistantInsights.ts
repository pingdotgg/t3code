export type AssistantTextSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "insight"; readonly title: "Insight"; readonly body: string };

const INSIGHT_START = /^([ \t]*)(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_END = /^([ \t]*)(`?)─{3,}\2[ \t]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/u;
const REFERENCE_DEFINITION =
  /^ {0,3}\[[^[\]\n]+\]:[ \t]*(?:<[^<>\n]+>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/u;
const INDENTED_CODE = /^(?: {4,}|\t)[ \t]*\S/u;

function fenceMarker(line: string): string | undefined {
  const open = FENCE_OPEN.exec(line);
  const marker = open?.[1];
  if (marker === undefined) return undefined;
  if (marker.startsWith("`") && (open?.[2] ?? "").includes("`")) return undefined;
  return marker;
}

function closesFence(line: string, marker: string): boolean {
  const token = FENCE_CLOSE.exec(line)?.[1];
  return token !== undefined && token.startsWith(marker[0] ?? "") && token.length >= marker.length;
}

function pushMarkdown(parts: AssistantTextSegment[], lines: string[]): void {
  const text = lines.join("\n").replace(/^\n+|\n+$/gu, "");
  lines.length = 0;
  if (text.length > 0) parts.push({ kind: "markdown", text });
}

function insight(body: readonly string[]): AssistantTextSegment {
  return { kind: "insight", title: "Insight", body: body.join("\n").replace(/^\n+|\n+$/gu, "") };
}

/**
 * Explanatory and learning styles wrap notes in a `★ Insight` box-drawing fence.
 * Those rules wrap through the message under `overflow-wrap: anywhere`, so they
 * are removed here and drawn as a callout instead of markdown.
 */
export function splitAssistantInsights(text: string): readonly AssistantTextSegment[] {
  if (!text.includes("★ Insight")) return [{ kind: "markdown", text }];

  const lines = text.split(/\r\n|\r|\n/u);
  const parts: AssistantTextSegment[] = [];
  const markdown: string[] = [];
  const definitions: string[] = [];
  let fence: string | undefined;
  let insightIndent: string | undefined;
  const insightBody: string[] = [];
  let found = false;
  let paragraph = false;

  const rememberDefinition = (line: string) => {
    if (REFERENCE_DEFINITION.test(line) && !definitions.includes(line)) definitions.push(line);
  };

  const take = (bucket: string[], line: string) => {
    if (fence !== undefined) {
      bucket.push(line);
      if (closesFence(line, fence)) fence = undefined;
      return true;
    }
    const marker = fenceMarker(line);
    if (marker === undefined) return false;
    fence = marker;
    bucket.push(line);
    return true;
  };

  for (const line of lines) {
    if (insightIndent === undefined) {
      if (take(markdown, line)) {
        paragraph = false;
        continue;
      }
      if (/^[ \t]*$/u.test(line) || (!paragraph && INDENTED_CODE.test(line))) {
        paragraph = false;
        markdown.push(line);
        continue;
      }
      paragraph = true;
      const start = INSIGHT_START.exec(line);
      if (start) {
        pushMarkdown(parts, markdown);
        insightIndent = start[1] ?? "";
        insightBody.length = 0;
        found = true;
        paragraph = false;
        continue;
      }
      rememberDefinition(line);
      markdown.push(line);
      continue;
    }

    const content = line.startsWith(insightIndent) ? line.slice(insightIndent.length) : line;
    if (take(insightBody, content)) continue;
    const end = INSIGHT_END.exec(line);
    if (end && (end[1] ?? "") === insightIndent) {
      parts.push(insight(insightBody));
      insightIndent = undefined;
      insightBody.length = 0;
      paragraph = false;
      continue;
    }
    rememberDefinition(content);
    insightBody.push(content);
  }

  if (!found) return [{ kind: "markdown", text }];
  if (insightIndent !== undefined) parts.push(insight(insightBody));
  else pushMarkdown(parts, markdown);
  if (definitions.length === 0 || parts.length < 2) return parts;
  const block = `${definitions.join("\n")}\n\n`;
  return parts.map((part) =>
    part.kind === "insight"
      ? part.body.length === 0
        ? part
        : { ...part, body: block + part.body }
      : part.text.length === 0
        ? part
        : { kind: "markdown", text: block + part.text },
  );
}
