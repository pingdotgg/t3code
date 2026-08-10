import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, MessageSquareIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
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
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import {
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { readEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { openUrlInPreview } from "~/components/preview/openUrlInPreview";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  threadRef?: ScopedThreadRef;
}

type MarkdownFunctionComponentProps<K extends keyof Components> = Parameters<
  Extract<NonNullable<Components[K]>, (...args: Array<never>) => unknown>
>[0];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
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
    !isValidElement<{
      className?: string;
      children?: ReactNode;
      node?: { tagName?: string };
    }>(onlyChild)
  ) {
    return null;
  }
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: Array<MarkdownAstNode>;
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

const THREAD_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_ID_PATTERN = new RegExp(`^${THREAD_ID_SOURCE}$`, "i");
const THREAD_REFERENCE_PATTERN = new RegExp(
  `\\b(Thread\\s*:?[ \\t]+)(${THREAD_ID_SOURCE})\\b`,
  "gi",
);

function normalizeThreadId(threadId: string): string {
  return threadId.toLowerCase();
}

function threadLinkProperties(environmentId: EnvironmentId, threadId: string) {
  return {
    dataThreadEnvironmentId: environmentId,
    dataThreadId: normalizeThreadId(threadId),
  };
}

function buildThreadHref(environmentId: EnvironmentId, threadId: string): string {
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(normalizeThreadId(threadId))}`;
}

function linkThreadReferencesInText(
  node: MarkdownAstNode,
  environmentId: EnvironmentId,
): MarkdownAstNode[] {
  const text = node.value ?? "";
  const nextNodes: MarkdownAstNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(THREAD_REFERENCE_PATTERN)) {
    const matchIndex = match.index;
    const prefix = match[1];
    const threadId = match[2];
    if (matchIndex === undefined || !prefix || !threadId) continue;
    const normalizedThreadId = normalizeThreadId(threadId);

    const threadIdStart = matchIndex + prefix.length;
    if (threadIdStart > cursor) {
      nextNodes.push({ type: "text", value: text.slice(cursor, threadIdStart) });
    }
    nextNodes.push({
      type: "link",
      url: buildThreadHref(environmentId, normalizedThreadId),
      data: {
        hProperties: threadLinkProperties(environmentId, normalizedThreadId),
      },
      children: [{ type: "text", value: normalizedThreadId }],
    });
    cursor = threadIdStart + threadId.length;
  }

  if (nextNodes.length === 0) return [node];
  if (cursor < text.length) {
    nextNodes.push({ type: "text", value: text.slice(cursor) });
  }
  return nextNodes;
}

function remarkLinkThreadReferences(environmentId?: EnvironmentId) {
  return () => (tree: MarkdownAstNode) => {
    if (!environmentId) return;

    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && THREAD_ID_PATTERN.test(node.value ?? "")) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            ...threadLinkProperties(environmentId, node.value ?? ""),
          },
        };
        return;
      }

      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      if (!node.children || childInsideLink) return;

      node.children = node.children.flatMap((child) => {
        if (child.type === "text") {
          return linkThreadReferencesInText(child, environmentId);
        }
        visit(child, false);
        return [child];
      });
    };

    visit(tree, false);
  };
}

function remarkTagInlineCode(cwd?: string) {
  return () => (tree: MarkdownAstNode) => {
    const inlineCodeCandidates: Array<{
      node: MarkdownAstNode;
      meta: MarkdownFileLinkMeta;
    }> = [];
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink) {
        const meta = resolveInlineCodeFileLinkMeta(node.value ?? "", cwd);
        if (meta) {
          inlineCodeCandidates.push({ node, meta });
        }
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
    const suffixByPath = buildFileLinkParentSuffixByPath(
      inlineCodeCandidates.map(({ meta }) => meta.filePath),
    );
    for (const { node, meta } of inlineCodeCandidates) {
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          dataInlineCode: "",
          dataInlineCodeLabel: buildFileLinkLabel(meta, suffixByPath.get(meta.filePath)),
        },
      };
    }
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
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

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // Skip Shiki tokenization while the code block is streaming. Re-tokenizing
  // the entire (growing) block on every delta is O(N^2) over the streaming
  // window and was a measurable cause of UI sluggishness during long Claude/
  // Codex responses. We render the raw text with monospace styling instead;
  // the cache path above runs exactly once after streaming completes.
  if (isStreaming) {
    return (
      <pre className="chat-markdown-shiki overflow-x-auto whitespace-pre-wrap break-words">
        <code className={className}>{code}</code>
      </pre>
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  label: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef;
  className?: string | undefined;
}

interface MarkdownThreadLinkProps {
  threadRef: ScopedThreadRef;
  className?: string | undefined;
}

type MarkdownExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  threadRef?: ScopedThreadRef;
};

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";
const MARKDOWN_THREAD_LINK_CLASS_NAME =
  "chat-markdown-thread-link relative top-[2px] max-w-full no-underline";

function resolveMarkdownThreadRef(
  properties: Record<string, unknown> | undefined,
): ScopedThreadRef | null {
  const environmentId = properties?.dataThreadEnvironmentId;
  const threadId = properties?.dataThreadId;
  if (typeof environmentId !== "string" || typeof threadId !== "string") return null;
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
  };
}

const MarkdownThreadLink = memo(function MarkdownThreadLink({
  threadRef,
  className,
}: MarkdownThreadLinkProps) {
  const navigate = useNavigate();
  const href = buildThreadHref(threadRef.environmentId, threadRef.threadId);
  const threadTitle = useStore(
    (state) => selectSidebarThreadSummaryByRef(state, threadRef)?.title.trim() || null,
  );
  const label = threadTitle ?? threadRef.threadId;

  return (
    <a
      href={href}
      className={cn(MARKDOWN_THREAD_LINK_CLASS_NAME, className)}
      title={
        threadTitle ? `${threadTitle}\n${threadRef.threadId}` : `Open thread ${threadRef.threadId}`
      }
      aria-label={`Open thread ${label}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          },
        });
      }}
    >
      <MessageSquareIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span className={cn("truncate", threadTitle ? null : "font-mono")}>{label}</span>
    </a>
  );
});

const MarkdownExternalLink = memo(function MarkdownExternalLink({
  href,
  threadRef,
  children,
  ...props
}: MarkdownExternalLinkProps) {
  const openPreview = useAtomCommand(previewEnvironment.open);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (
        !threadRef ||
        !/^https?:\/\//i.test(href) ||
        !isPreviewSupportedInRuntime() ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void openUrlInPreview({ threadRef, url: href, openPreview })
        .then((result) => {
          if (result._tag !== "Failure") return;

          const localApi = readLocalApi();
          if (!localApi) {
            toastManager.add({
              type: "error",
              title: "Unable to open link",
              description: "The integrated browser is unavailable.",
            });
            return;
          }
          void localApi.shell.openExternal(href).catch((error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Unable to open link",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          });
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
    },
    [href, openPreview, threadRef],
  );

  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
});

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

function buildFileLinkLabel(meta: MarkdownFileLinkMeta, parentSuffix?: string): string {
  const labelParts = [meta.basename];
  if (parentSuffix) {
    labelParts.push(parentSuffix);
  }
  if (meta.line) {
    labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
  }
  return labelParts.join(" · ");
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
  threadRef,
  className,
}: MarkdownFileLinkProps) {
  const environmentApi = threadRef ? readEnvironmentApi(threadRef.environmentId) : undefined;
  const openPreview = useAtomCommand(previewEnvironment.open);
  const handleOpen = useCallback(() => {
    const httpBaseUrl = threadRef ? getEnvironmentHttpBaseUrl(threadRef.environmentId) : null;
    if (
      threadRef &&
      environmentApi &&
      httpBaseUrl &&
      isPreviewSupportedInRuntime() &&
      isBrowserPreviewFile(filePath)
    ) {
      void openFileInPreview({
        threadRef,
        relativePath: filePath,
        httpBaseUrl,
        createAssetUrl: environmentApi.assets.createUrl,
        openPreview,
      }).catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return;
    }
    const localApi = readLocalApi();
    if (!localApi) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    void openInPreferredEditor(localApi, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [environmentApi, filePath, openPreview, targetPath, threadRef]);

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
    previous.threadRef?.environmentId === next.threadRef?.environmentId &&
    previous.threadRef?.threadId === next.threadRef?.threadId &&
    previous.className === next.className
  );
}

const markdownComponentsWithoutRuntimeState = {
  p({ node: _node, children, ...props }) {
    return <p {...props}>{children}</p>;
  },
  li({ node: _node, children, ...props }) {
    return <li {...props}>{children}</li>;
  },
  blockquote({ node: _node, children, ...props }) {
    return <blockquote {...props}>{children}</blockquote>;
  },
  h1({ node: _node, children, ...props }) {
    return <h1 {...props}>{children}</h1>;
  },
  h2({ node: _node, children, ...props }) {
    return <h2 {...props}>{children}</h2>;
  },
  h3({ node: _node, children, ...props }) {
    return <h3 {...props}>{children}</h3>;
  },
  h4({ node: _node, children, ...props }) {
    return <h4 {...props}>{children}</h4>;
  },
  h5({ node: _node, children, ...props }) {
    return <h5 {...props}>{children}</h5>;
  },
  h6({ node: _node, children, ...props }) {
    return <h6 {...props}>{children}</h6>;
  },
  td({ node: _node, children, ...props }) {
    return <td {...props}>{children}</td>;
  },
  th({ node: _node, children, ...props }) {
    return <th {...props}>{children}</th>;
  },
  code({ node: _node, children, ...props }) {
    return <code {...props}>{children}</code>;
  },
} satisfies Components;

function ChatMarkdown({ text, cwd, isStreaming = false, threadRef }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
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
    return buildFileLinkParentSuffixByPath(
      [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
    );
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownAnchor = useCallback(
    ({ node, href, ...props }: MarkdownFunctionComponentProps<"a">) => {
      const linkedThreadRef = resolveMarkdownThreadRef(node?.properties);
      if (linkedThreadRef) {
        return <MarkdownThreadLink threadRef={linkedThreadRef} className={props.className} />;
      }

      const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
      const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
      if (!fileLinkMeta) {
        return (
          <MarkdownExternalLink
            href={href ?? ""}
            {...(threadRef ? { threadRef } : {})}
            {...props}
          />
        );
      }

      return (
        <MarkdownFileLink
          href={fileLinkMeta.targetPath}
          targetPath={fileLinkMeta.targetPath}
          displayPath={fileLinkMeta.displayPath}
          filePath={fileLinkMeta.filePath}
          label={buildFileLinkLabel(
            fileLinkMeta,
            fileLinkParentSuffixByPath.get(fileLinkMeta.filePath),
          )}
          theme={resolvedTheme}
          {...(threadRef ? { threadRef } : {})}
          className={props.className}
        />
      );
    },
    [fileLinkParentSuffixByPath, markdownFileLinkMetaByHref, resolvedTheme, threadRef],
  );
  const markdownPre = useCallback(
    ({ node: _node, children, ...props }: MarkdownFunctionComponentProps<"pre">) => {
      const codeBlock = extractCodeBlock(children);
      if (!codeBlock) {
        return <pre {...props}>{children}</pre>;
      }

      return (
        <MarkdownCodeBlock code={codeBlock.code}>
          <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
            <Suspense fallback={<pre {...props}>{children}</pre>}>
              <SuspenseShikiCodeBlock
                className={codeBlock.className}
                code={codeBlock.code}
                themeName={diffThemeName}
                isStreaming={isStreaming}
              />
            </Suspense>
          </CodeHighlightErrorBoundary>
        </MarkdownCodeBlock>
      );
    },
    [diffThemeName, isStreaming],
  );
  const markdownCode = useCallback(
    ({ node, children, className, ...props }: MarkdownFunctionComponentProps<"code">) => {
      const linkedThreadRef = resolveMarkdownThreadRef(node?.properties);
      if (linkedThreadRef) {
        return <MarkdownThreadLink threadRef={linkedThreadRef} className={className} />;
      }

      if (node?.properties?.dataInlineCode != null) {
        const codeText = nodeToPlainText(children);
        const fileLinkMeta = resolveInlineCodeFileLinkMeta(codeText, cwd);
        const label = node.properties.dataInlineCodeLabel;
        if (fileLinkMeta && typeof label === "string") {
          return (
            <MarkdownFileLink
              href={fileLinkMeta.targetPath}
              targetPath={fileLinkMeta.targetPath}
              displayPath={fileLinkMeta.displayPath}
              filePath={fileLinkMeta.filePath}
              label={label}
              theme={resolvedTheme}
            />
          );
        }
      }
      return (
        <code {...props} className={className}>
          {children}
        </code>
      );
    },
    [cwd, resolvedTheme],
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      ...markdownComponentsWithoutRuntimeState,
      a: markdownAnchor,
      code: markdownCode,
      pre: markdownPre,
    }),
    [markdownAnchor, markdownCode, markdownPre],
  );

  return (
    <div className="chat-markdown w-full min-w-0 leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkLinkThreadReferences(threadRef?.environmentId),
          remarkTagInlineCode(cwd),
        ]}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
