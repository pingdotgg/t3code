import { getSharedHighlighter } from "@pierre/diffs";
import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LRUCache } from "../lib/lruCache";
import { readNativeApi } from "../nativeApi";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffThemes";
import { fnv1a32 } from "../lib/diffRendering";
import { useTheme } from "../hooks/useTheme";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { preferredTerminalEditor } from "../terminal-links";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
interface InFlightHighlight {
  promise: Promise<string>;
  enableCache: () => void;
}
const inFlightHighlights = new Map<string, InFlightHighlight>();

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

async function highlightCodeBlock(code: string, language: string, themeName: DiffThemeName) {
  try {
    const highlighter = await getSharedHighlighter({
      themes: [themeName],
      langs: [language],
    });
    return highlighter.codeToHtml(code, { lang: language, theme: themeName });
  } catch {
    const highlighter = await getSharedHighlighter({
      themes: [themeName],
      langs: ["text"],
    });
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
  }
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getCachedOrCreateHighlight({
  cacheKey,
  code,
  language,
  themeName,
  useCache,
}: {
  cacheKey: string;
  code: string;
  language: string;
  themeName: DiffThemeName;
  useCache: boolean;
}): Promise<string> {
  if (useCache) {
    const cached = highlightedCodeCache.get(cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }
  }

  const existingInFlight = inFlightHighlights.get(cacheKey);
  if (existingInFlight) {
    if (useCache) {
      existingInFlight.enableCache();
    }
    return existingInFlight.promise;
  }

  let shouldCache = useCache;
  const requestPromise = highlightCodeBlock(code, language, themeName)
    .then((html) => {
      if (shouldCache) {
        highlightedCodeCache.set(cacheKey, html, estimateHighlightedSize(html, code));
      }
      return html;
    })
    .finally(() => {
      inFlightHighlights.delete(cacheKey);
    });

  inFlightHighlights.set(cacheKey, {
    promise: requestPromise,
    enableCache: () => {
      shouldCache = true;
    },
  });
  return requestPromise;
}

interface ShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  fallback: ReactNode;
}

function ShikiCodeBlock({ className, code, themeName, isStreaming, fallback }: ShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const [highlightState, setHighlightState] = useState<{
    cacheKey: string;
    html: string | null;
  }>(() => ({
    cacheKey,
    html: isStreaming ? null : (highlightedCodeCache.get(cacheKey) ?? null),
  }));
  const cachedHighlightedHtml = isStreaming ? null : (highlightedCodeCache.get(cacheKey) ?? null);
  const highlightedHtml =
    cachedHighlightedHtml ?? (highlightState.cacheKey === cacheKey ? highlightState.html : null);

  useEffect(() => {
    let cancelled = false;

    if (cachedHighlightedHtml) {
      setHighlightState((current) => {
        if (current.cacheKey === cacheKey && current.html === cachedHighlightedHtml) {
          return current;
        }
        return { cacheKey, html: cachedHighlightedHtml };
      });
      return () => {
        cancelled = true;
      };
    }

    setHighlightState((current) => {
      if (current.cacheKey === cacheKey) {
        return current;
      }
      return { cacheKey, html: null };
    });

    void getCachedOrCreateHighlight({
      cacheKey,
      code,
      language,
      themeName,
      useCache: !isStreaming,
    })
      .then((html) => {
        if (cancelled) {
          return;
        }
        setHighlightState((current) => {
          if (current.cacheKey === cacheKey && current.html === html) {
            return current;
          }
          return { cacheKey, html };
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [cacheKey, cachedHighlightedHtml, code, isStreaming, language, themeName]);

  if (!highlightedHtml) {
    return fallback;
  }

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function ChatMarkdown({ text, cwd, isStreaming = false }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          return <a {...props} href={href} target="_blank" rel="noreferrer" />;
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const api = readNativeApi();
              if (api) {
                void api.shell.openInEditor(targetPath, preferredTerminalEditor());
              } else {
                console.warn("Native API not found. Unable to open file in editor.");
              }
            }}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <ShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            isStreaming={isStreaming}
            fallback={<pre {...props}>{children}</pre>}
          />
        );
      },
    }),
    [cwd, diffThemeName, isStreaming],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
