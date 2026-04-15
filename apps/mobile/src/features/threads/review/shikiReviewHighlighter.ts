import { getFiletypeFromFileName } from "@pierre/diffs/utils";

import {
  hasTurboModuleProxy,
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
  type ReviewHighlighterEngine,
} from "./reviewHighlighterEngine";
import type { ReviewRenderableFile, ReviewRenderableLineRow } from "./reviewModel";

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
const REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE = resolveReviewHighlighterEnginePreference(
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE,
);

const highlightCache = new Map<string, Promise<ReviewHighlightedFile>>();
const resolvedHighlightCache = new Map<string, ReviewHighlightedFile>();
const loadedLanguages = new Set<string>(["text"]);
type ShikiHighlighter = {
  loadLanguage: (...langs: string[]) => Promise<void>;
  codeToTokensBase: (
    code: string,
    options: { readonly lang: string; readonly theme: string },
  ) => Promise<Array<Array<{ content: string; color?: string; fontStyle?: number }>>>;
};
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let activeHighlighterEnginePromise: Promise<ReviewHighlighterEngine> | null = null;

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function joinPatchLines(lines: ReadonlyArray<string>): string {
  return lines.map(stripTrailingNewline).join("\n");
}

async function getHighlighter() {
  if (!highlighterPromise) {
    const configuredHighlighterPromise = import("shiki").then(async (shikiModule) => {
      const nativeRuntimeAvailable = hasTurboModuleProxy();
      let nativeEngineAvailable = false;

      if (nativeRuntimeAvailable && REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE !== "javascript") {
        try {
          const nativeEngineModule = await import("react-native-shiki-engine");
          nativeEngineAvailable = nativeEngineModule.isNativeEngineAvailable();
          if (nativeEngineAvailable) {
            const createHighlighter = shikiModule.createBundledHighlighter({
              langs: shikiModule.bundledLanguages,
              themes: shikiModule.bundledThemes,
              engine: () => nativeEngineModule.createNativeEngine(),
            });
            const highlighter = await createHighlighter({
              themes: [SHIKI_THEME_BY_SCHEME.light, SHIKI_THEME_BY_SCHEME.dark],
              langs: [],
            });
            return {
              highlighter: highlighter as unknown as ShikiHighlighter,
              engine: "native" as const,
            };
          }
        } catch {
          nativeEngineAvailable = false;
        }
      }

      const engine = resolveReviewHighlighterEngine(
        REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        nativeEngineAvailable,
      );
      const createHighlighter = shikiModule.createBundledHighlighter({
        langs: shikiModule.bundledLanguages,
        themes: shikiModule.bundledThemes,
        engine: () => shikiModule.createJavaScriptRegexEngine(),
      });
      const highlighter = await createHighlighter({
        themes: [SHIKI_THEME_BY_SCHEME.light, SHIKI_THEME_BY_SCHEME.dark],
        langs: [],
      });
      return {
        highlighter: highlighter as unknown as ShikiHighlighter,
        engine,
      };
    });

    highlighterPromise = configuredHighlighterPromise.then((result) => result.highlighter);
    activeHighlighterEnginePromise = configuredHighlighterPromise.then((result) => result.engine);
  }

  return highlighterPromise as Promise<ShikiHighlighter>;
}

export async function getActiveReviewHighlighterEngine(): Promise<ReviewHighlighterEngine> {
  await getHighlighter();
  return (activeHighlighterEnginePromise ??
    Promise.resolve("javascript")) as Promise<ReviewHighlighterEngine>;
}

async function resolveLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): Promise<string> {
  const candidate = languageHint ?? getFiletypeFromFileName(path);
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

async function resolveLanguage(file: ReviewRenderableFile): Promise<string> {
  return resolveLanguageFromPath(file.path, file.languageHint);
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

function getHighlightCacheKey(file: ReviewRenderableFile, theme: ReviewDiffTheme): string {
  return `${SHIKI_THEME_BY_SCHEME[theme]}:${file.cacheKey}`;
}

export function getCachedHighlightedReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): ReviewHighlightedFile | null {
  return resolvedHighlightCache.get(getHighlightCacheKey(file, theme)) ?? null;
}

export async function highlightReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): Promise<ReviewHighlightedFile> {
  const shikiTheme = SHIKI_THEME_BY_SCHEME[theme];
  const cacheKey = getHighlightCacheKey(file, theme);
  const resolved = resolvedHighlightCache.get(cacheKey);
  if (resolved) {
    return resolved;
  }
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

    const highlighted = { additionLines, deletionLines };
    resolvedHighlightCache.set(cacheKey, highlighted);
    return highlighted;
  })();

  highlightCache.set(cacheKey, promise);
  return promise;
}

export async function highlightReviewSelectedLines(input: {
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly theme: ReviewDiffTheme;
  readonly languageHint?: string | null;
}): Promise<Record<string, ReadonlyArray<ReviewHighlightedToken>>> {
  if (input.lines.length === 0) {
    return {};
  }

  const language = await resolveLanguageFromPath(input.filePath, input.languageHint ?? null);
  const shikiTheme = SHIKI_THEME_BY_SCHEME[input.theme];
  const additionLikeLines = input.lines
    .filter((line) => line.change !== "delete")
    .map((line) => `${line.content}\n`);
  const deletionLines = input.lines
    .filter((line) => line.change === "delete")
    .map((line) => `${line.content}\n`);
  const [additionTokens, deletionTokens] = await Promise.all([
    highlightLines(joinPatchLines(additionLikeLines), language, shikiTheme),
    highlightLines(joinPatchLines(deletionLines), language, shikiTheme),
  ]);

  const tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>> = {};
  let additionIndex = 0;
  let deletionIndex = 0;

  input.lines.forEach((line) => {
    if (line.change === "delete") {
      tokenMap[line.id] = deletionTokens[deletionIndex] ?? [];
      deletionIndex += 1;
      return;
    }

    tokenMap[line.id] = additionTokens[additionIndex] ?? [];
    additionIndex += 1;
  });

  return tokenMap;
}
