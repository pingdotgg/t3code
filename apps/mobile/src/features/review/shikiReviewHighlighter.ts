import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { getFiletypeFromFileName } from "@pierre/diffs";
import bashLanguage from "@shikijs/langs/bash";
import javascriptLanguage from "@shikijs/langs/javascript";
import jsonLanguage from "@shikijs/langs/json";
import jsxLanguage from "@shikijs/langs/jsx";
import tsxLanguage from "@shikijs/langs/tsx";
import typescriptLanguage from "@shikijs/langs/typescript";
import yamlLanguage from "@shikijs/langs/yaml";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import * as Schema from "effect/Schema";

import {
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
  type ReviewHighlighterEngine,
} from "./reviewHighlighterEngine";
import type { ReviewRenderableFile, ReviewRenderableLineRow } from "./reviewModel";
import { applyDiffRangesToTokens, computeWordAltDiffRanges } from "./reviewWordDiffs";

export type ReviewDiffTheme = "light" | "dark";
export type { ReviewHighlighterEngine };

export class ReviewHighlighterEngineInitializationError extends Schema.TaggedErrorClass<ReviewHighlighterEngineInitializationError>()(
  "ReviewHighlighterEngineInitializationError",
  {
    preferredEngine: Schema.Literals(["native", "javascript"]),
    attemptedEngine: Schema.Literals(["native", "javascript"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the ${this.attemptedEngine} review highlighter with ${this.preferredEngine} preferred.`;
  }
}

export interface ReviewHighlightedToken {
  content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
  readonly diffHighlight?: boolean;
}

export interface ReviewHighlightedFile {
  readonly additionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
  readonly deletionLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>;
}

export interface ReviewHighlightFileProgress {
  readonly highlightedFile: ReviewHighlightedFile;
  readonly complete: boolean;
  readonly highlightedLineCount: number;
}

const SHIKI_THEME_NAME_BY_SCHEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;
const REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE =
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE ??
  (process.env.NODE_ENV === "test" ? "javascript" : "native");
const REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE = resolveReviewHighlighterEnginePreference(
  REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE,
);
const REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE = resolveReviewHighlighterBooleanFlag(
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_DISABLE_CACHE,
  false,
);
const REVIEW_HIGHLIGHT_RESULT_CACHE_LIMIT = 8;
const REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD = 8;
const REVIEW_HIGHLIGHT_CHUNK_SIZE = 200;
const REVIEW_TOKENIZE_MAX_LINE_LENGTH = 1_000;
const highlightCache = new Map<string, Promise<ReviewHighlightedFile>>();
const resolvedHighlightCache = new Map<string, ReviewHighlightedFile>();
const REVIEW_INITIAL_LANGUAGE_MODULES = [
  bashLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];
const loadedLanguages = new Set<string>([
  "text",
  "bash",
  "javascript",
  "json",
  "jsx",
  "tsx",
  "typescript",
  "yaml",
]);
const languageLoadingPromises = new Map<string, Promise<boolean>>();
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  svg: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  fish: () => import("@shikijs/langs/fish"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  regex: () => import("@shikijs/langs/regex"),
  viml: () => import("@shikijs/langs/viml"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  vim: "viml",
  objc: "objective-c",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  tf: "hcl",
  make: "makefile",
  plain: "text",
  plaintext: "text",
  txt: "text",
};
let highlighterPromise: Promise<HighlighterCore> | null = null;
let activeHighlighterEnginePromise: Promise<ReviewHighlighterEngine> | null = null;

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore["loadLanguage"]>[0];
};

function resolveReviewHighlighterBooleanFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  switch (value) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      return defaultValue;
  }
}

function isReviewHighlighterDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewHighlighterDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-highlighter] ${message}`, details);
    return;
  }

  console.log(`[review-highlighter] ${message}`);
}

function logReviewHighlighterDiagnosticError(message: string, error: unknown): void {
  if (!isReviewHighlighterDebugLoggingEnabled()) {
    return;
  }
  console.error(`[review-highlighter] ${message}`, error);
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function joinPatchLines(lines: ReadonlyArray<string>): string {
  return lines.map(stripTrailingNewline).join("\n");
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const configuredHighlighterPromise = (async () => {
      let nativeEngineAvailable = false;
      let nativeInitializationError: ReviewHighlighterEngineInitializationError | undefined;

      logReviewHighlighterDiagnostic("initializing", {
        configuredPreference: REVIEW_HIGHLIGHTER_ENGINE_ENV_VALUE,
        preference: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        resultCacheDisabled: REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE,
      });

      const themes = [githubLightDefault, githubDarkDefault];

      if (REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE !== "javascript") {
        try {
          const nativeEngineModule = await import("react-native-shiki-engine");
          nativeEngineAvailable = nativeEngineModule.isNativeEngineAvailable();
          logReviewHighlighterDiagnostic("checked native engine availability", {
            nativeEngineAvailable,
          });

          if (nativeEngineAvailable) {
            logReviewHighlighterDiagnostic("creating native regex engine");
            const highlighter = await createHighlighterCore({
              themes,
              langs: REVIEW_INITIAL_LANGUAGE_MODULES,
              engine: nativeEngineModule.createNativeEngine(),
            });
            logReviewHighlighterDiagnostic("using native engine");
            return {
              highlighter,
              engine: "native" as const,
            };
          }
        } catch (error) {
          nativeInitializationError = new ReviewHighlighterEngineInitializationError({
            preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
            attemptedEngine: "native",
            cause: error,
          });
          logReviewHighlighterDiagnosticError(
            "native engine initialization failed; falling back to javascript",
            nativeInitializationError,
          );
          nativeEngineAvailable = false;
        }
      } else {
        logReviewHighlighterDiagnostic("skipping native engine probe", {
          reason: "preference-forced-javascript",
        });
      }

      const engine = resolveReviewHighlighterEngine(
        REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
        nativeEngineAvailable,
      );
      let highlighter: HighlighterCore;
      try {
        highlighter = await createHighlighterCore({
          themes,
          langs: REVIEW_INITIAL_LANGUAGE_MODULES,
          engine: createJavaScriptRegexEngine(),
        });
      } catch (cause) {
        const javascriptError = new ReviewHighlighterEngineInitializationError({
          preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
          attemptedEngine: "javascript",
          cause,
        });
        if (!nativeInitializationError) throw javascriptError;
        throw new ReviewHighlighterEngineInitializationError({
          preferredEngine: REVIEW_HIGHLIGHTER_ENGINE_PREFERENCE,
          attemptedEngine: "javascript",
          cause: new AggregateError(
            [nativeInitializationError, javascriptError],
            "Native and JavaScript review highlighter initialization failed.",
            { cause: nativeInitializationError },
          ),
        });
      }
      logReviewHighlighterDiagnostic("using javascript engine", {
        resolvedEngine: engine,
      });
      return {
        highlighter,
        engine,
      };
    })();

    highlighterPromise = configuredHighlighterPromise
      .then((result) => result.highlighter)
      .catch((error) => {
        highlighterPromise = null;
        activeHighlighterEnginePromise = null;
        throw error;
      });
    activeHighlighterEnginePromise = configuredHighlighterPromise
      .then((result) => result.engine)
      .catch((error) => {
        activeHighlighterEnginePromise = null;
        throw error;
      });
  }

  return highlighterPromise;
}

export async function getActiveReviewHighlighterEngine(): Promise<ReviewHighlighterEngine> {
  await getHighlighter();
  return activeHighlighterEnginePromise ?? Promise.resolve("javascript");
}

export async function prepareReviewHighlighter(): Promise<void> {
  await getHighlighter();
}

export async function prepareReviewHighlighterLanguages(
  languages: ReadonlyArray<string>,
): Promise<void> {
  const highlighter = await getHighlighter();
  await Promise.all(
    languages.map(async (language) => {
      const candidate = resolveLanguageAlias(language);
      if (candidate === "text" || !(candidate in languageImports)) {
        return;
      }

      await loadSingleLanguage(highlighter, candidate);
    }),
  );
}

function resolveLanguageAlias(language: string): string {
  const normalized = language.toLowerCase();
  return languageAliases[normalized] ?? normalized;
}

function resolveLoadedLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): string | null {
  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const candidate = resolveLanguageAlias(detectedLanguage);
  if (candidate === "text" || candidate === "ansi") {
    return "text";
  }

  if (!(candidate in languageImports)) {
    return "text";
  }

  return loadedLanguages.has(candidate) ? candidate : null;
}

async function loadSingleLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true;
  }

  const existingPromise = languageLoadingPromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const importer = languageImports[language];
  if (!importer) {
    return false;
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule;
      await highlighter.loadLanguage(languageModule.default);
      loadedLanguages.add(language);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadingPromises.delete(language);
    }
  })();

  languageLoadingPromises.set(language, loadingPromise);
  return loadingPromise;
}

async function resolveLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): Promise<string> {
  const loadedLanguage = resolveLoadedLanguageFromPath(path, languageHint);
  if (loadedLanguage) {
    return loadedLanguage;
  }

  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const candidate = resolveLanguageAlias(detectedLanguage);
  if (candidate === "text" || candidate === "ansi") {
    return "text";
  }

  if (!(candidate in languageImports)) {
    return "text";
  }

  if (loadedLanguages.has(candidate)) {
    return candidate;
  }

  const highlighter = await getHighlighter();
  const loaded = await loadSingleLanguage(highlighter, candidate);
  if (!loaded) {
    return "text";
  }

  return candidate;
}

async function resolveLanguage(file: ReviewRenderableFile): Promise<string> {
  return (
    resolveLoadedLanguageFromPath(file.path, file.languageHint) ??
    (await resolveLanguageFromPath(file.path, file.languageHint))
  );
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

function makePlainHighlightedLines(
  lines: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> {
  return lines.map((line) => [
    {
      content: stripTrailingNewline(line),
      color: null,
      fontStyle: null,
    },
  ]);
}

function applyWordAltDiffHighlightsToFile(
  file: ReviewRenderableFile,
  highlighted: ReviewHighlightedFile,
): ReviewHighlightedFile {
  const nextAdditionLines = [...highlighted.additionLines];
  const nextDeletionLines = [...highlighted.deletionLines];
  const processedPairs = new Set<string>();
  let changed = false;

  file.rows.forEach((row) => {
    if (row.kind !== "line" || row.change === "context" || !row.comparison) {
      return;
    }

    const deletionTokenIndex =
      row.change === "delete"
        ? row.deletionTokenIndex
        : row.comparison.change === "delete"
          ? row.comparison.tokenIndex
          : null;
    const additionTokenIndex =
      row.change === "add"
        ? row.additionTokenIndex
        : row.comparison.change === "add"
          ? row.comparison.tokenIndex
          : null;

    if (deletionTokenIndex === null || additionTokenIndex === null) {
      return;
    }

    const pairKey = `${deletionTokenIndex}:${additionTokenIndex}`;
    if (processedPairs.has(pairKey)) {
      return;
    }
    processedPairs.add(pairKey);

    const deletionLine = stripTrailingNewline(file.deletionLines[deletionTokenIndex] ?? "");
    const additionLine = stripTrailingNewline(file.additionLines[additionTokenIndex] ?? "");
    const ranges = computeWordAltDiffRanges({ deletionLine, additionLine });

    if (ranges.deletion.length > 0) {
      nextDeletionLines[deletionTokenIndex] = applyDiffRangesToTokens(
        nextDeletionLines[deletionTokenIndex] ?? [],
        ranges.deletion,
      );
      changed = true;
    }

    if (ranges.addition.length > 0) {
      nextAdditionLines[additionTokenIndex] = applyDiffRangesToTokens(
        nextAdditionLines[additionTokenIndex] ?? [],
        ranges.addition,
      );
      changed = true;
    }
  });

  return changed
    ? {
        additionLines: nextAdditionLines,
        deletionLines: nextDeletionLines,
      }
    : highlighted;
}

function applyWordAltDiffHighlightsToSelectedLines(input: {
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly tokenMap: Record<string, ReadonlyArray<ReviewHighlightedToken>>;
}): Record<string, ReadonlyArray<ReviewHighlightedToken>> {
  const additionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();
  const deletionLineByTokenIndex = new Map<number, ReviewRenderableLineRow>();

  input.lines.forEach((line) => {
    if (line.change === "add" && line.additionTokenIndex !== null) {
      additionLineByTokenIndex.set(line.additionTokenIndex, line);
    }
    if (line.change === "delete" && line.deletionTokenIndex !== null) {
      deletionLineByTokenIndex.set(line.deletionTokenIndex, line);
    }
  });

  const nextTokenMap = { ...input.tokenMap };
  const processedPairs = new Set<string>();

  input.lines.forEach((line) => {
    if (line.change === "context" || !line.comparison) {
      return;
    }

    const pairedDeletionLine =
      line.change === "delete"
        ? line
        : line.comparison.change === "delete"
          ? deletionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;
    const pairedAdditionLine =
      line.change === "add"
        ? line
        : line.comparison.change === "add"
          ? additionLineByTokenIndex.get(line.comparison.tokenIndex)
          : undefined;

    if (
      !pairedDeletionLine ||
      !pairedAdditionLine ||
      pairedDeletionLine.deletionTokenIndex === null ||
      pairedAdditionLine.additionTokenIndex === null
    ) {
      return;
    }

    const pairKey = `${pairedDeletionLine.deletionTokenIndex}:${pairedAdditionLine.additionTokenIndex}`;
    if (processedPairs.has(pairKey)) {
      return;
    }
    processedPairs.add(pairKey);

    const ranges = computeWordAltDiffRanges({
      deletionLine: pairedDeletionLine.content,
      additionLine: pairedAdditionLine.content,
    });

    if (ranges.deletion.length > 0) {
      nextTokenMap[pairedDeletionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedDeletionLine.id] ?? [],
        ranges.deletion,
      );
    }
    if (ranges.addition.length > 0) {
      nextTokenMap[pairedAdditionLine.id] = applyDiffRangesToTokens(
        nextTokenMap[pairedAdditionLine.id] ?? [],
        ranges.addition,
      );
    }
  });

  return nextTokenMap;
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
  const sourceLines = code.split("\n");
  const highlightedLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
  const shortLineBatch: string[] = [];

  const flushShortLineBatch = async (): Promise<void> => {
    if (shortLineBatch.length === 0) {
      return;
    }

    const tokenLines = highlighter.codeToTokensBase(shortLineBatch.join("\n"), {
      lang: language,
      theme,
    });
    highlightedLines.push(...normalizeHighlightedLines(tokenLines));
    shortLineBatch.length = 0;
  };

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex] ?? "";

    if (line.length > REVIEW_TOKENIZE_MAX_LINE_LENGTH) {
      await flushShortLineBatch();
      highlightedLines.push([{ content: line, color: null, fontStyle: null }]);
    } else {
      shortLineBatch.push(line);
    }

    if (shortLineBatch.length >= REVIEW_HIGHLIGHT_CHUNK_SIZE) {
      await flushShortLineBatch();
    }

    if (
      sourceLines.length > REVIEW_HIGHLIGHT_CHUNK_LINE_THRESHOLD &&
      lineIndex + 1 < sourceLines.length &&
      (shortLineBatch.length === 0 || line.length > REVIEW_TOKENIZE_MAX_LINE_LENGTH)
    ) {
      await waitForNextFrame();
    }
  }

  await flushShortLineBatch();

  return highlightedLines;
}

export async function highlightCodeSnippet(input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const languageHint = input.language?.trim() || "text";
  const language = await resolveLanguageFromPath(`snippet.${languageHint}`, languageHint);
  return highlightLines(input.code, language, SHIKI_THEME_NAME_BY_SCHEME[input.theme]);
}

export async function highlightSourceFile(input: {
  readonly path: string;
  readonly contents: string;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const language = await resolveLanguageFromPath(input.path);
  return highlightLines(input.contents, language, SHIKI_THEME_NAME_BY_SCHEME[input.theme]);
}

async function highlightPatchLinesInChunks(input: {
  readonly lines: ReadonlyArray<string>;
  readonly language: string;
  readonly theme: string;
  readonly onChunk: (
    startIndex: number,
    tokens: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>,
  ) => void;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  if (input.lines.length === 0) {
    return [];
  }

  const highlighter = await getHighlighter();
  const highlightedLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];

  for (
    let startIndex = 0;
    startIndex < input.lines.length;
    startIndex += REVIEW_HIGHLIGHT_CHUNK_SIZE
  ) {
    const lineChunk = input.lines.slice(startIndex, startIndex + REVIEW_HIGHLIGHT_CHUNK_SIZE);
    const chunkTokens: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
    const tokenizableLines: string[] = [];
    const tokenizableIndexes: number[] = [];

    lineChunk.forEach((line, index) => {
      const strippedLine = stripTrailingNewline(line);
      if (strippedLine.length > REVIEW_TOKENIZE_MAX_LINE_LENGTH) {
        chunkTokens[index] = [{ content: strippedLine, color: null, fontStyle: null }];
        return;
      }

      tokenizableIndexes.push(index);
      tokenizableLines.push(strippedLine);
    });

    if (tokenizableLines.length > 0) {
      const tokenLines = highlighter.codeToTokensBase(tokenizableLines.join("\n"), {
        lang: input.language,
        theme: input.theme,
      });
      const normalizedTokenLines = normalizeHighlightedLines(tokenLines);

      tokenizableIndexes.forEach((chunkIndex, tokenIndex) => {
        chunkTokens[chunkIndex] = normalizedTokenLines[tokenIndex] ?? [];
      });
    }

    const completedChunk = lineChunk.map((_, index) => chunkTokens[index] ?? []);
    highlightedLines.push(...completedChunk);
    input.onChunk(startIndex, completedChunk);

    if (startIndex + REVIEW_HIGHLIGHT_CHUNK_SIZE < input.lines.length) {
      await waitForNextFrame();
    }
  }

  return highlightedLines;
}

function getHighlightCacheKey(file: ReviewRenderableFile, theme: ReviewDiffTheme): string {
  return `${SHIKI_THEME_NAME_BY_SCHEME[theme]}:${file.cacheKey}`;
}

function storeResolvedHighlightedFile(cacheKey: string, highlighted: ReviewHighlightedFile): void {
  if (resolvedHighlightCache.has(cacheKey)) {
    resolvedHighlightCache.delete(cacheKey);
  }

  resolvedHighlightCache.set(cacheKey, highlighted);

  while (resolvedHighlightCache.size > REVIEW_HIGHLIGHT_RESULT_CACHE_LIMIT) {
    const oldestKey = resolvedHighlightCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    resolvedHighlightCache.delete(oldestKey);
  }
}

export function clearReviewHighlightFileCache(): void {
  highlightCache.clear();
  resolvedHighlightCache.clear();
}

export function getCachedHighlightedReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): ReviewHighlightedFile | null {
  if (REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    return null;
  }

  return resolvedHighlightCache.get(getHighlightCacheKey(file, theme)) ?? null;
}

export async function highlightReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
): Promise<ReviewHighlightedFile> {
  const shikiTheme = SHIKI_THEME_NAME_BY_SCHEME[theme];
  const cacheKey = getHighlightCacheKey(file, theme);
  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    const resolved = resolvedHighlightCache.get(cacheKey);
    if (resolved) {
      logReviewHighlighterDiagnostic("file highlight cache hit (resolved)", {
        fileId: file.id,
        filePath: file.path,
        theme,
      });
      return resolved;
    }
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      logReviewHighlighterDiagnostic("file highlight cache hit (pending)", {
        fileId: file.id,
        filePath: file.path,
        theme,
      });
      return cached;
    }
  }

  const promise = (async () => {
    const startedAt = Date.now();
    logReviewHighlighterDiagnostic("file highlight start", {
      fileId: file.id,
      filePath: file.path,
      theme,
      additionLineCount: file.additionLines.length,
      deletionLineCount: file.deletionLines.length,
      rowCount: file.rows.length,
    });
    const loadedLanguage = resolveLoadedLanguageFromPath(file.path, file.languageHint);
    const language = loadedLanguage ?? (await resolveLanguage(file));
    if (language === "text") {
      const highlighted = applyWordAltDiffHighlightsToFile(file, {
        additionLines: makePlainHighlightedLines(file.additionLines),
        deletionLines: makePlainHighlightedLines(file.deletionLines),
      });
      if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
        storeResolvedHighlightedFile(cacheKey, highlighted);
      }
      logReviewHighlighterDiagnostic("file highlight complete", {
        fileId: file.id,
        filePath: file.path,
        theme,
        language,
        highlightedAdditionLineCount: highlighted.additionLines.length,
        highlightedDeletionLineCount: highlighted.deletionLines.length,
        durationMs: Date.now() - startedAt,
      });
      return highlighted;
    }

    const additionLines = await highlightLines(
      joinPatchLines(file.additionLines),
      language,
      shikiTheme,
    );
    await waitForNextFrame();
    const deletionLines = await highlightLines(
      joinPatchLines(file.deletionLines),
      language,
      shikiTheme,
    );
    await waitForNextFrame();

    const highlighted = applyWordAltDiffHighlightsToFile(file, { additionLines, deletionLines });
    if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
      storeResolvedHighlightedFile(cacheKey, highlighted);
    }
    logReviewHighlighterDiagnostic("file highlight complete", {
      fileId: file.id,
      filePath: file.path,
      theme,
      language,
      highlightedAdditionLineCount: highlighted.additionLines.length,
      highlightedDeletionLineCount: highlighted.deletionLines.length,
      durationMs: Date.now() - startedAt,
    });
    return highlighted;
  })();

  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    highlightCache.set(cacheKey, promise);
  }
  return promise.finally(() => {
    if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
      highlightCache.delete(cacheKey);
    }
  });
}

export async function streamHighlightReviewFile(
  file: ReviewRenderableFile,
  theme: ReviewDiffTheme,
  onProgress: (progress: ReviewHighlightFileProgress) => void,
): Promise<ReviewHighlightedFile> {
  const shikiTheme = SHIKI_THEME_NAME_BY_SCHEME[theme];
  const cacheKey = getHighlightCacheKey(file, theme);
  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    const resolved = resolvedHighlightCache.get(cacheKey);
    if (resolved) {
      onProgress({
        highlightedFile: resolved,
        complete: true,
        highlightedLineCount: resolved.additionLines.length + resolved.deletionLines.length,
      });
      return resolved;
    }
  }

  const startedAt = Date.now();
  logReviewHighlighterDiagnostic("file stream highlight start", {
    fileId: file.id,
    filePath: file.path,
    theme,
    additionLineCount: file.additionLines.length,
    deletionLineCount: file.deletionLines.length,
    rowCount: file.rows.length,
  });

  const loadedLanguage = resolveLoadedLanguageFromPath(file.path, file.languageHint);
  const language = loadedLanguage ?? (await resolveLanguage(file));
  if (language === "text") {
    const highlighted = applyWordAltDiffHighlightsToFile(file, {
      additionLines: makePlainHighlightedLines(file.additionLines),
      deletionLines: makePlainHighlightedLines(file.deletionLines),
    });
    if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
      storeResolvedHighlightedFile(cacheKey, highlighted);
    }
    onProgress({
      highlightedFile: highlighted,
      complete: true,
      highlightedLineCount: highlighted.additionLines.length + highlighted.deletionLines.length,
    });
    logReviewHighlighterDiagnostic("file stream highlight complete", {
      fileId: file.id,
      filePath: file.path,
      theme,
      language,
      highlightedAdditionLineCount: highlighted.additionLines.length,
      highlightedDeletionLineCount: highlighted.deletionLines.length,
      highlightedLineCount: highlighted.additionLines.length + highlighted.deletionLines.length,
      durationMs: Date.now() - startedAt,
    });
    return highlighted;
  }

  const additionLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
  const deletionLines: Array<ReadonlyArray<ReviewHighlightedToken>> = [];
  let highlightedLineCount = 0;

  await highlightPatchLinesInChunks({
    lines: file.additionLines,
    language,
    theme: shikiTheme,
    onChunk: (startIndex, tokens) => {
      tokens.forEach((lineTokens, index) => {
        additionLines[startIndex + index] = lineTokens;
      });
      highlightedLineCount += tokens.length;
    },
  });
  await waitForNextFrame();
  await highlightPatchLinesInChunks({
    lines: file.deletionLines,
    language,
    theme: shikiTheme,
    onChunk: (startIndex, tokens) => {
      tokens.forEach((lineTokens, index) => {
        deletionLines[startIndex + index] = lineTokens;
      });
      highlightedLineCount += tokens.length;
    },
  });

  const highlighted = applyWordAltDiffHighlightsToFile(file, { additionLines, deletionLines });
  if (!REVIEW_HIGHLIGHTER_DISABLE_RESULT_CACHE) {
    storeResolvedHighlightedFile(cacheKey, highlighted);
  }
  onProgress({
    highlightedFile: highlighted,
    complete: true,
    highlightedLineCount,
  });
  logReviewHighlighterDiagnostic("file stream highlight complete", {
    fileId: file.id,
    filePath: file.path,
    theme,
    language,
    highlightedAdditionLineCount: highlighted.additionLines.length,
    highlightedDeletionLineCount: highlighted.deletionLines.length,
    highlightedLineCount,
    durationMs: Date.now() - startedAt,
  });
  return highlighted;
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

  const loadedLanguage = resolveLoadedLanguageFromPath(input.filePath, input.languageHint ?? null);
  const language =
    loadedLanguage ?? (await resolveLanguageFromPath(input.filePath, input.languageHint ?? null));
  const shikiTheme = SHIKI_THEME_NAME_BY_SCHEME[input.theme];
  const additionLikeLines: string[] = [];
  const deletionLines: string[] = [];
  for (const line of input.lines) {
    if (line.change === "delete") {
      deletionLines.push(`${line.content}\n`);
    } else {
      additionLikeLines.push(`${line.content}\n`);
    }
  }
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

  return applyWordAltDiffHighlightsToSelectedLines({
    lines: input.lines,
    tokenMap,
  });
}
