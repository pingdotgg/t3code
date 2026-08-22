const CONTENT_REFERENCE_PATTERN =
  /^\s*[\uE200\uFFFD]visualize[\uE202\uFFFD](\{.*\})[\uE201\uFFFD]\s*$/u;
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;

export interface InlineVisualizationReference {
  readonly kind: "visualization";
  readonly path: string;
  readonly mode?: "wide";
  readonly title?: string;
}

export type InlineVisualizationPart =
  | { readonly key: string; readonly kind: "markdown"; readonly text: string }
  | (InlineVisualizationReference & { readonly key: string });

function parseInlineVisualizationReference(line: string): InlineVisualizationReference | null {
  const match = CONTENT_REFERENCE_PATTERN.exec(line);
  if (!match?.[1]) return null;

  try {
    const payload: unknown = JSON.parse(match[1]);
    if (!isRecord(payload) || typeof payload.path !== "string") return null;

    const path = payload.path.trim();
    if (!isSafeAbsoluteHtmlPath(path)) return null;
    if (payload.mode !== undefined && payload.mode !== "wide") return null;
    if (payload.title !== undefined && typeof payload.title !== "string") return null;
    const title = typeof payload.title === "string" ? payload.title.trim() : "";

    return {
      kind: "visualization",
      path,
      ...(payload.mode === "wide" ? { mode: "wide" as const } : {}),
      ...(title ? { title } : {}),
    };
  } catch {
    return null;
  }
}

/** Splits only standalone references; examples inside fenced code stay Markdown. */
export function splitInlineVisualizations(text: string): InlineVisualizationPart[] {
  if (!/[\uE200\uFFFD]visualize[\uE202\uFFFD]/u.test(text)) {
    return [{ key: "markdown:0", kind: "markdown", text }];
  }
  const parts: InlineVisualizationPart[] = [];
  let markdownLines: string[] = [];
  let codeFence: { readonly character: string; readonly length: number } | null = null;

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return;
    parts.push({
      key: `markdown:${parts.length}`,
      kind: "markdown",
      text: markdownLines.join("\n"),
    });
    markdownLines = [];
  };

  for (const line of text.split("\n")) {
    const fenceMatch = CODE_FENCE_PATTERN.exec(line);
    const fence = fenceMatch?.[1];
    if (fence) {
      if (!codeFence) {
        codeFence = { character: fence[0]!, length: fence.length };
      } else if (
        fence[0] === codeFence.character &&
        fence.length >= codeFence.length &&
        line.slice(fenceMatch[0].length).trim() === ""
      ) {
        codeFence = null;
      }
      markdownLines.push(line);
      continue;
    }

    const visualization = codeFence ? null : parseInlineVisualizationReference(line);
    if (!visualization) {
      markdownLines.push(line);
      continue;
    }

    flushMarkdown();
    parts.push({ ...visualization, key: `visualization:${parts.length}` });
  }

  flushMarkdown();
  return parts;
}

export function textReferencesInlineVisualizationPath(text: string, path: string): boolean {
  return splitInlineVisualizations(text).some(
    (part) => part.kind === "visualization" && part.path === path,
  );
}

export function stripInlineVisualizations(text: string): string {
  return splitInlineVisualizations(text)
    .filter((part) => part.kind === "markdown")
    .map((part) => part.text)
    .join("\n");
}

function isSafeAbsoluteHtmlPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  return (
    (normalized.startsWith("/") || /^[a-zA-Z]:\//u.test(normalized)) &&
    !normalized.split("/").some((segment) => segment === "..") &&
    /\.(?:html?|xhtml)$/iu.test(normalized)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
