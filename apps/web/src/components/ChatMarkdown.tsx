import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { fnv1a32 } from "../lib/diffRendering";
import { resolveSyntaxThemeName } from "../lib/syntaxTheme";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import {
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";

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
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const unsupportedHighlightLanguages = new Set<string>();
const HIGHLIGHT_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  baml: "text",
  gitignore: "ini",
  plaintext: "text",
  txt: "text",
};

function normalizeHighlightLanguage(language: string): string {
  const normalizedLanguage = language.trim().toLowerCase();
  if (!normalizedLanguage) {
    return "text";
  }
  return HIGHLIGHT_LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage;
}

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  return normalizeHighlightLanguage(raw);
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

function createHighlightCacheKey(code: string, language: string, themeName: string): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string, themeName: string): Promise<DiffsHighlighter> {
  const highlighterLanguage = unsupportedHighlightLanguages.has(language) ? "text" : language;
  const cacheKey = `${highlighterLanguage}:${themeName}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [themeName],
    langs: [highlighterLanguage as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(cacheKey);
    if (highlighterLanguage === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    unsupportedHighlightLanguages.add(highlighterLanguage);
    return getHighlighterPromise("text", themeName);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}

function renderHighlightedHtml(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  themeName: string,
): string {
  const highlightLanguage = unsupportedHighlightLanguages.has(language) ? "text" : language;
  try {
    return highlighter.codeToHtml(code, {
      lang: highlightLanguage as SupportedLanguages,
      theme: themeName,
    });
  } catch (error) {
    if (highlightLanguage === "text") {
      throw error;
    }
    unsupportedHighlightLanguages.add(highlightLanguage);
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
  }
}

function scheduleHighlightWork(callback: () => void): () => void {
  if (typeof window === "undefined") {
    callback();
    return () => undefined;
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const idleHandle = idleWindow.requestIdleCallback(callback, { timeout: 1500 });
    return () => idleWindow.cancelIdleCallback?.(idleHandle);
  }

  const timeoutHandle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timeoutHandle);
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface ShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: string;
  isStreaming: boolean;
  fallback: ReactNode;
}

type HighlightedCodeState = {
  cacheKey: string;
  html: string;
};

function ShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
  fallback,
}: ShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const [highlightedCode, setHighlightedCode] = useState<HighlightedCodeState | null>(() => {
    const cachedHighlightedHtml = isStreaming ? null : highlightedCodeCache.get(cacheKey);
    return cachedHighlightedHtml == null ? null : { cacheKey, html: cachedHighlightedHtml };
  });

  useEffect(() => {
    if (isStreaming) {
      setHighlightedCode(null);
      return;
    }

    const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);
    if (cachedHighlightedHtml != null) {
      setHighlightedCode({ cacheKey, html: cachedHighlightedHtml });
      return;
    }

    let isCancelled = false;
    let cancelHighlightWork: (() => void) | null = null;
    setHighlightedCode(null);

    void getHighlighterPromise(language, themeName)
      .then((highlighter) => {
        if (isCancelled) return;
        cancelHighlightWork = scheduleHighlightWork(() => {
          if (isCancelled) return;
          let highlightedHtml: string;
          try {
            highlightedHtml = renderHighlightedHtml(highlighter, code, language, themeName);
          } catch {
            return;
          }
          if (isCancelled) return;
          highlightedCodeCache.set(
            cacheKey,
            highlightedHtml,
            estimateHighlightedSize(highlightedHtml, code),
          );
          setHighlightedCode({ cacheKey, html: highlightedHtml });
        });
      })
      .catch(() => {
        if (!isCancelled) {
          setHighlightedCode(null);
        }
      });

    return () => {
      isCancelled = true;
      cancelHighlightWork?.();
    };
  }, [cacheKey, code, isStreaming, language, themeName]);

  const cachedHighlightedHtml = isStreaming ? null : highlightedCodeCache.get(cacheKey);
  const activeHighlightedHtml =
    cachedHighlightedHtml ?? (highlightedCode?.cacheKey === cacheKey ? highlightedCode.html : null);

  if (activeHighlightedHtml == null) {
    return <>{fallback}</>;
  }

  return (
    <div
      className="chat-markdown-shiki"
      dangerouslySetInnerHTML={{ __html: activeHighlightedHtml }}
    />
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  label,
  theme,
  className,
}: MarkdownFileLinkProps) {
  const handleOpen = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    void openInPreferredEditor(api, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [targetPath]);

  const handleCopy = useCallback((value: string, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: value,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "open", label: "Open in editor" },
          { id: "copy-relative", label: "Copy relative path" },
          { id: "copy-full", label: "Copy full path" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "open") {
        handleOpen();
        return;
      }
      if (clicked === "copy-relative") {
        handleCopy(displayPath, "Relative path");
        return;
      }
      if (clicked === "copy-full") {
        handleCopy(targetPath, "Full path");
      }
    },
    [displayPath, handleCopy, handleOpen, targetPath],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleOpen();
            }}
            onContextMenu={handleContextMenu}
          >
            <VscodeEntryIcon
              pathValue={filePath}
              kind="file"
              theme={theme}
              className={cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current")}
            />
            <span className={MARKDOWN_FILE_LINK_LABEL_CLASS_NAME}>{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.filePath === next.filePath &&
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className
  );
}

function ChatMarkdown({ text, cwd, isStreaming = false }: ChatMarkdownProps) {
  const { resolvedTheme, resolvedColorTheme } = useTheme();
  const codeBlockThemeName = useMemo(
    () => resolveSyntaxThemeName({ resolvedTheme, resolvedColorTheme }),
    [resolvedColorTheme, resolvedTheme],
  );
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
        if (!fileLinkMeta) {
          return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (fileLinkMeta.line) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={fileLinkMeta.targetPath}
            targetPath={fileLinkMeta.targetPath}
            displayPath={fileLinkMeta.displayPath}
            filePath={fileLinkMeta.filePath}
            label={labelParts.join(" · ")}
            theme={resolvedTheme}
            className={props.className}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <ShikiCodeBlock
              className={codeBlock.className}
              code={codeBlock.code}
              themeName={codeBlockThemeName}
              isStreaming={isStreaming}
              fallback={<pre {...props}>{children}</pre>}
            />
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      codeBlockThemeName,
      fileLinkParentSuffixByPath,
      isStreaming,
      markdownFileLinkMetaByHref,
      resolvedTheme,
    ],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
