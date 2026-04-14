import { getFiletypeFromFileName } from "@pierre/diffs/utils";

import type { ReviewRenderableFile } from "./reviewModel";

export type ReviewDiffTheme = "light" | "dark";

export interface ReviewHighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export interface ReviewHighlightedFile {
  readonly additionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
  readonly deletionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
}

const SHIKI_THEME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

const highlightCache = new Map<string, Promise<ReviewHighlightedFile>>();
const loadedLanguages = new Set<string>(["text"]);
type ShikiHighlighter = {
  loadLanguage: (...langs: string[]) => Promise<void>;
  codeToTokensBase: (
    code: string,
    options: { readonly lang: string; readonly theme: string },
  ) => Promise<Array<Array<{ content: string; color?: string; fontStyle?: number }>>>;
};
let highlighterPromise: Promise<ShikiHighlighter> | null = null;

function cleanLastNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function joinPatchLines(lines: ReadonlyArray<string>): string {
  if (lines.length === 0) {
    return "";
  }

  return cleanLastNewline(lines.join(""));
}

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(
      async ({ createHighlighter, createJavaScriptRegexEngine }) => {
        const highlighter = await createHighlighter({
          themes: [SHIKI_THEME_BY_SCHEME.light, SHIKI_THEME_BY_SCHEME.dark],
          langs: [],
          engine: createJavaScriptRegexEngine(),
        });
        return highlighter as unknown as ShikiHighlighter;
      },
    );
  }

  return highlighterPromise as Promise<ShikiHighlighter>;
}

async function resolveLanguage(file: ReviewRenderableFile): Promise<string> {
  const candidate = file.languageHint ?? getFiletypeFromFileName(file.path);
  if (!candidate || candidate === "text" || candidate === "ansi") {
    return "text";
  }

  const highlighter = await getHighlighter();
  if (!loadedLanguages.has(candidate)) {
    try {
      await highlighter.loadLanguage(candidate);
      loadedLanguages.add(candidate);
    } catch {
      return "text";
    }
  }

  return candidate;
}

function normalizeHighlightedLines(
  tokenLines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string; fontStyle?: number }>>,
): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> {
  return tokenLines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

async function highlightLines(
  code: string,
  language: string,
  theme: string,
): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  if (code.length === 0) {
    return [];
  }

  const highlighter = await getHighlighter();
  const tokenLines = await highlighter.codeToTokensBase(code, { lang: language, theme });
  return normalizeHighlightedLines(tokenLines);
}

export async function highlightReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): Promise<ReviewHighlightedFile> {
  const shikiTheme = SHIKI_THEME_BY_SCHEME[theme];
  const cacheKey = `${shikiTheme}:${file.cacheKey}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const language = await resolveLanguage(file);
    const [additionLines, deletionLines] = await Promise.all([
      highlightLines(joinPatchLines(file.additionLines), language, shikiTheme),
      highlightLines(joinPatchLines(file.deletionLines), language, shikiTheme),
    ]);

    return { additionLines, deletionLines };
  })();

  highlightCache.set(cacheKey, promise);
  return promise;
}
