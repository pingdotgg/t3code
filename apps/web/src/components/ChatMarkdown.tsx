import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { buildThreadPath } from "@t3tools/shared/threadUrl";
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
import { useShallow } from "zustand/react/shallow";
import { stabilizeStringMap } from "./chat/MessagesTimeline.logic";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { reportClientWarning } from "../lib/clientLogger";
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
import { selectProjectByRef, selectSidebarThreadSummaryByRef, useStore } from "../store";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { useSavedEnvironmentRegistryStore } from "~/environments/runtime/catalog";
import {
  isThreadId,
  buildGitHubIssueReferenceUrl,
  parseGitHubReferences,
  resolveExplicitThreadLink,
  THREAD_REFERENCE_PATTERN,
  type TrustedThreadOrigin,
} from "../lib/chatLinkClassification";
import { githubPullRequestNavigation, openPullRequestLink } from "../lib/openPullRequestLink";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useProjectEntriesQuery } from "./files/projectFilesQueryState";
import { buildFileParentSuffixByPath } from "../filePathDisambiguation";
import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useOpenLink } from "~/browser/useOpenLink";
import { readEnvironmentApi } from "~/environmentApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { toWorkspaceRelativePath } from "../filePathDisplay";

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
  className?: string;
  /** Directory that anchors relative links; defaults to `cwd`. Set
      to the file's own directory when rendering a markdown file. */
  imageBaseDir?: string | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
}

type MarkdownFunctionComponentProps<K extends keyof Components> = Parameters<
  Extract<NonNullable<Components[K]>, (...args: Array<never>) => unknown>
>[0];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const WEB_CITATION_TOKEN_PATTERN = /\uE200cite(?:\uE202turn\d+[A-Za-z]+\d+)+\uE201/g;
const TRAILING_PARTIAL_WEB_CITATION_PATTERN = /\uE200cite[\s\S]*$/;
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

function normalizeChatMarkdownText(text: string, isStreaming: boolean): string {
  const normalized = text.replace(WEB_CITATION_TOKEN_PATTERN, "");
  return isStreaming ? normalized.replace(TRAILING_PARTIAL_WEB_CITATION_PATTERN, "") : normalized;
}

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Array<MarkdownAstNode>;
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

function normalizeThreadId(threadId: string): string {
  return threadId.toLowerCase();
}

function threadLinkProperties(environmentId: EnvironmentId, threadId: string) {
  return {
    dataThreadEnvironmentId: environmentId,
    dataThreadId: normalizeThreadId(threadId),
  };
}

function linkChatReferencesInText(
  node: MarkdownAstNode,
  input: {
    readonly environmentId?: EnvironmentId;
    readonly githubReferences: ReadonlyMap<string, string>;
  },
): MarkdownAstNode[] {
  const text = node.value ?? "";
  const matches = [
    ...[...text.matchAll(THREAD_REFERENCE_PATTERN)].flatMap((match) => {
      // Thread references resolve against an environment; without one the raw
      // text must pass through untouched.
      if (!input.environmentId) return [];
      const matchIndex = match.index;
      const prefix = match[1];
      const threadId = match[2];
      if (matchIndex === undefined || !prefix || !threadId) return [];
      return [
        {
          start: matchIndex,
          end: matchIndex + prefix.length + threadId.length,
          kind: "thread" as const,
          labelStart: matchIndex + prefix.length,
          value: threadId,
        },
      ];
    }),
    ...[...text.matchAll(/(?:\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/g)].flatMap(
      (match) => {
        const matchIndex = match.index;
        const repository = match[1];
        const rawNumber = match[2];
        if (matchIndex === undefined || !rawNumber) return [];
        const value = repository ? `${repository}#${rawNumber}` : `#${rawNumber}`;
        const url = input.githubReferences.get(value.toLowerCase());
        if (!url) return [];
        return [
          {
            start: matchIndex,
            end: matchIndex + value.length,
            kind: "pull-request" as const,
            labelStart: matchIndex,
            labelEnd: matchIndex + value.length,
            value,
            url,
          },
        ];
      },
    ),
  ].sort((left, right) => left.start - right.start);

  const nextNodes: MarkdownAstNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.labelStart > cursor) {
      nextNodes.push({ type: "text", value: text.slice(cursor, match.labelStart) });
    }
    const normalizedValue = match.kind === "thread" ? normalizeThreadId(match.value) : match.value;
    if (match.kind === "thread" && input.environmentId && isThreadId(match.value)) {
      nextNodes.push({
        type: "link",
        url: buildThreadPath({
          environmentId: input.environmentId,
          threadId: ThreadId.make(normalizedValue),
        }),
        data: {
          hProperties: threadLinkProperties(input.environmentId, normalizedValue),
        },
        children: [{ type: "text", value: normalizedValue }],
      });
    } else if (match.kind === "pull-request") {
      const url = "url" in match ? match.url : undefined;
      if (!url) continue;
      nextNodes.push({
        type: "link",
        url,
        ...(githubPullRequestNavigation(url)
          ? {
              data: {
                hProperties: {
                  dataGitHubPullRequestUrl: url,
                },
              },
            }
          : {}),
        children: [{ type: "text", value: match.value }],
      });
    }
    cursor = match.end;
  }

  if (nextNodes.length === 0) return [node];
  if (cursor < text.length) {
    nextNodes.push({ type: "text", value: text.slice(cursor) });
  }
  return nextNodes;
}

function hasThreadContextBeforeInlineCode(
  children: ReadonlyArray<MarkdownAstNode>,
  index: number,
): boolean {
  const previous = children[index - 1];
  return (
    previous?.type === "text" &&
    /(?:\bthread(?:\s+id)?|thread[_-]?id)\s*:?[ \t]*$/i.test(previous.value ?? "")
  );
}

function remarkClassifyChatLinks(input: {
  readonly environmentId?: EnvironmentId;
  readonly baseOrigin: string;
  readonly trustedOrigins: ReadonlyArray<TrustedThreadOrigin>;
  readonly githubReferences: ReadonlyMap<string, string>;
}) {
  return () => (tree: MarkdownAstNode) => {
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: MarkdownAstNode) => {
      if (node.type === "definition" && node.identifier && node.url) {
        definitions.set(normalizeReferenceIdentifier(node.identifier), node.url);
      }
      node.children?.forEach(collectDefinitions);
    };
    collectDefinitions(tree);

    const classifyLinkDestination = (node: MarkdownAstNode, href: string) => {
      const threadLink = resolveExplicitThreadLink(href, {
        baseOrigin: input.baseOrigin,
        trustedOrigins: input.trustedOrigins,
      });
      if (threadLink) {
        node.url = threadLink.href;
        node.data = {
          ...node.data,
          hProperties: threadLinkProperties(threadLink.ref.environmentId, threadLink.ref.threadId),
        };
        return;
      }

      const pullRequest = githubPullRequestNavigation(href);
      if (pullRequest) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataGitHubPullRequestUrl: href,
          },
        };
      }
    };

    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      if (!node.children || childInsideLink) return;

      node.children.forEach((child, index) => {
        if (
          input.environmentId &&
          child.type === "inlineCode" &&
          isThreadId(child.value ?? "") &&
          hasThreadContextBeforeInlineCode(node.children ?? [], index)
        ) {
          child.data = {
            ...child.data,
            hProperties: {
              ...child.data?.hProperties,
              ...threadLinkProperties(input.environmentId, child.value ?? ""),
            },
          };
        }
      });

      node.children = node.children.flatMap((child) => {
        if (child.type === "text") {
          // Qualified owner/repo#N references are repository-complete, so link
          // them even without a thread environment; thread inference still
          // requires one (enforced inside linkChatReferencesInText).
          return linkChatReferencesInText(child, {
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            githubReferences: input.githubReferences,
          });
        }
        visit(child, false);
        return [child];
      });
    };

    const visitLinks = (node: MarkdownAstNode, insideLink: boolean) => {
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      if (node.type === "link" && !insideLink && node.url) {
        classifyLinkDestination(node, node.url);
      } else if (node.type === "linkReference" && !insideLink && node.identifier) {
        const href = definitions.get(normalizeReferenceIdentifier(node.identifier));
        if (href) {
          classifyLinkDestination(node, href);
        }
      }
      node.children?.forEach((child) => visitLinks(child, childInsideLink));
    };

    visit(tree, false);
    visitLinks(tree, false);
  };
}

function normalizeReferenceIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

const CHAT_FILE_POSITION_SUFFIX_PATTERN = /:(\d+(?:[,:]\d+)*)$/;

function extractChatFilePositionSuffix(codeText: string): string | null {
  const match = codeText.trim().match(CHAT_FILE_POSITION_SUFFIX_PATTERN);
  return match?.[1] ?? null;
}

function buildChatInlineCodeLabel(
  meta: MarkdownFileLinkMeta,
  parentSuffix: string | undefined,
  originalText: string,
): string {
  const raw = extractChatFilePositionSuffix(originalText);
  if (raw && raw.includes(",")) {
    const labelParts = [meta.basename];
    if (parentSuffix) {
      labelParts.push(parentSuffix);
    }
    labelParts.push(`L${raw}`);
    return labelParts.join(" · ");
  }
  return buildFileLinkLabel(meta, parentSuffix);
}

interface WorkspaceFileEntryLike {
  readonly path: string;
  readonly kind: string;
}

function findWorkspaceRelativeForBasename(
  basename: string,
  entries: ReadonlyArray<WorkspaceFileEntryLike>,
): string | null {
  const matches = entries.filter(
    (entry) =>
      entry.kind === "file" && (entry.path === basename || entry.path.endsWith(`/${basename}`)),
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => {
    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return sorted[0]?.path ?? null;
}

function resolveChatInlineCodeMeta(
  codeText: string,
  cwd: string | undefined,
  entries: ReadonlyArray<WorkspaceFileEntryLike>,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const base = resolveInlineCodeFileLinkMeta(codeText, cwd, baseDir);
  if (!base || !cwd || entries.length === 0) return base;
  const trimmed = codeText.trim();
  const suffix = extractChatFilePositionSuffix(trimmed);
  const pathPart = suffix ? trimmed.slice(0, -(suffix.length + 1)) : trimmed;
  if (pathPart.includes("/") || pathPart.includes("\\")) return base;
  const basename = pathPart.split(/[\\/]/).at(-1) ?? pathPart;
  if (!basename) return base;
  const relative = findWorkspaceRelativeForBasename(basename, entries);
  if (!relative) return base;
  // Re-resolve with the workspace-relative path so the file panel opens the
  // real nested file instead of `cwd/basename`. The lookup result is already
  // workspace-relative, so it anchors at `cwd` — not at the previewed file's
  // directory, which would join it onto the wrong base.
  const candidate = suffix ? `${relative}:${suffix}` : relative;
  return resolveMarkdownFileLinkMeta(candidate, cwd, cwd) ?? base;
}

function remarkTagInlineCode(resolve: (codeText: string) => MarkdownFileLinkMeta | null) {
  return () => (tree: MarkdownAstNode) => {
    const inlineCodeCandidates: Array<{
      node: MarkdownAstNode;
      meta: MarkdownFileLinkMeta;
      original: string;
    }> = [];
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink) {
        const original = node.value ?? "";
        const meta = resolve(original);
        if (meta) {
          inlineCodeCandidates.push({ node, meta, original });
        }
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
    const suffixByPath = buildFileParentSuffixByPath(
      inlineCodeCandidates.map(({ meta }) => meta.filePath),
    );
    for (const { node, meta, original } of inlineCodeCandidates) {
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          dataInlineCode: "",
          dataInlineCodeLabel: buildChatInlineCodeLabel(
            meta,
            suffixByPath.get(meta.filePath),
            original,
          ),
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
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
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
      reportClientWarning(
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
  cwd?: string | undefined;
  line?: number | undefined;
  className?: string | undefined;
}

interface MarkdownThreadLinkProps {
  threadRef: ScopedThreadRef;
  className?: string | undefined;
  children?: ReactNode;
  preserveLabel?: boolean;
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
  if (!isThreadId(threadId)) return null;
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
  };
}

function resolveMarkdownPullRequestUrl(
  properties: Record<string, unknown> | undefined,
): string | null {
  const url = properties?.dataGitHubPullRequestUrl;
  return typeof url === "string" && githubPullRequestNavigation(url) ? url : null;
}

const MarkdownThreadLink = memo(function MarkdownThreadLink({
  threadRef,
  className,
  children,
  preserveLabel = false,
}: MarkdownThreadLinkProps) {
  const navigate = useNavigate();
  const href = buildThreadPath(threadRef);
  const threadTitle = useStore(
    (state) => selectSidebarThreadSummaryByRef(state, threadRef)?.title.trim() || null,
  );
  const environmentKnown = useStore((state) =>
    Boolean(state.environmentStateById[threadRef.environmentId]),
  );
  const threadShell = useStore(
    (state) =>
      state.environmentStateById[threadRef.environmentId]?.threadShellById[threadRef.threadId],
  );
  const label = preserveLabel
    ? nodeToPlainText(children) || threadRef.threadId
    : (threadTitle ?? threadRef.threadId);

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
        if (!environmentKnown) {
          event.preventDefault();
          event.stopPropagation();
          toastManager.add({
            type: "error",
            title: "Thread environment unavailable",
            description: `Connect environment ${threadRef.environmentId} before opening this thread.`,
          });
          return;
        }
        if (threadShell?.archivedAt) {
          event.preventDefault();
          event.stopPropagation();
          toastManager.add({
            type: "error",
            title: "Thread is archived",
            description: "Restore the archived thread before opening it from chat.",
          });
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
  const openLink = useOpenLink(threadRef);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!/^https?:\/\//i.test(href) || event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void openLink(href, { event }).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [href, openLink],
  );

  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
});

const MarkdownPullRequestLink = memo(function MarkdownPullRequestLink({
  href,
  children,
  threadRef,
  ...props
}: MarkdownExternalLinkProps & { readonly threadRef?: ScopedThreadRef }) {
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      openPullRequestLink(event, href, threadRef);
    },
    [href, threadRef],
  );

  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
});

export function githubRepositoryForProject(
  project:
    | {
        readonly repositoryIdentity?: {
          readonly provider?: string;
          readonly owner?: string;
          readonly name?: string;
          readonly canonicalKey: string;
        } | null;
      }
    | undefined,
): { readonly repository: string; readonly host: string } | null {
  const identity = project?.repositoryIdentity;
  if (identity?.provider !== "github") return null;
  const segments = identity.canonicalKey.split("/").filter(Boolean);
  // The canonical key leads with the remote hostname whenever it carries a
  // host/owner/repo shape. Accept single-label intranet hosts that contain
  // "github" (recognized as GitHub Self-Hosted) alongside dotted hostnames, so
  // a two-segment owner/repo key never misreads its owner as a host.
  const hostSegment = segments.length >= 3 ? segments[0]?.toLowerCase() : undefined;
  const host =
    hostSegment && (hostSegment.includes(".") || hostSegment.includes("github"))
      ? hostSegment
      : "github.com";
  if (identity.owner && identity.name) {
    return { repository: `${identity.owner}/${identity.name}`.toLowerCase(), host };
  }

  if (segments.length !== 3) {
    return null;
  }
  return { repository: `${segments[1]}/${segments[2]}`.toLowerCase(), host };
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
  cwd,
  line,
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
    if (threadRef) {
      const workspaceRelativePath = toWorkspaceRelativePath(filePath, cwd);
      if (workspaceRelativePath) {
        useRightPanelStore.getState().openFile(threadRef, workspaceRelativePath, line);
        return;
      }
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
  }, [cwd, environmentApi, filePath, line, openPreview, targetPath, threadRef]);

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
    previous.cwd === next.cwd &&
    previous.line === next.line &&
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

const EMPTY_WORKSPACE_ENTRIES: ReadonlyArray<WorkspaceFileEntryLike> = [];

interface ChatMarkdownViewProps extends ChatMarkdownProps {
  readonly workspaceEntries: ReadonlyArray<WorkspaceFileEntryLike>;
}

function ChatMarkdownView({
  text,
  cwd,
  isStreaming = false,
  threadRef,
  workspaceEntries,
  className,
  imageBaseDir,
  onTaskListChange,
}: ChatMarkdownViewProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const normalizedText = useMemo(
    () => normalizeChatMarkdownText(text, isStreaming),
    [isStreaming, text],
  );
  const environmentIds = useStore(
    useShallow((state) => Object.keys(state.environmentStateById) as EnvironmentId[]),
  );
  const savedEnvironmentById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentThread = useStore((state) =>
    threadRef
      ? state.environmentStateById[threadRef.environmentId]?.threadShellById[threadRef.threadId]
      : undefined,
  );
  const currentProject = useStore((state) =>
    currentThread
      ? selectProjectByRef(state, {
          environmentId: currentThread.environmentId,
          projectId: currentThread.projectId,
        })
      : undefined,
  );
  const trustedOrigins: ReadonlyArray<TrustedThreadOrigin> = useMemo(
    () => [
      {
        origin:
          typeof window === "undefined"
            ? "http://localhost"
            : (window.location?.origin ?? "http://localhost"),
      },
      ...(primaryEnvironmentId
        ? (() => {
            const httpBaseUrl = getEnvironmentHttpBaseUrl(primaryEnvironmentId);
            return httpBaseUrl
              ? [{ origin: httpBaseUrl, environmentId: primaryEnvironmentId }]
              : [];
          })()
        : []),
      ...environmentIds.flatMap((environmentId) => {
        const httpBaseUrl = getEnvironmentHttpBaseUrl(EnvironmentId.make(environmentId));
        return httpBaseUrl
          ? [{ origin: httpBaseUrl, environmentId: EnvironmentId.make(environmentId) }]
          : [];
      }),
      ...Object.values(savedEnvironmentById).map((environment) => ({
        origin: environment.httpBaseUrl,
        environmentId: environment.environmentId,
      })),
    ],
    [environmentIds, primaryEnvironmentId, savedEnvironmentById],
  );
  // Relative links resolve against the file's own directory when rendering
  // a markdown file, and against the workspace root everywhere else.
  const linkBaseDir = imageBaseDir ?? cwd;
  const resolveChatInlineCode = useCallback(
    (codeText: string) => resolveChatInlineCodeMeta(codeText, cwd, workspaceEntries, linkBaseDir),
    [cwd, linkBaseDir, workspaceEntries],
  );
  // Stabilize the map identity when streaming text grows without adding new
  // references: a fresh Map per chunk would otherwise rebuild remarkPlugins
  // and force react-markdown to re-tokenize the active row every chunk.
  const githubReferencesRef = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const githubReferences = useMemo(() => {
    const references = new Map<string, string>();
    const navigation = currentThread?.pullRequest?.url
      ? githubPullRequestNavigation(currentThread.pullRequest.url)
      : null;
    const projectRepository = githubRepositoryForProject(currentProject);
    const repository = projectRepository?.repository ?? null;
    const authoritativeRepository = navigation?.repository.toLowerCase() ?? repository;
    const authoritativeHost =
      navigation?.host.toLowerCase() ?? projectRepository?.host ?? "github.com";

    for (const reference of parseGitHubReferences(normalizedText)) {
      const referenceRepository = reference.repository ?? authoritativeRepository;
      if (!referenceRepository) continue;

      const referenceHost = reference.repository
        ? reference.repository === navigation?.repository.toLowerCase()
          ? (navigation?.host.toLowerCase() ?? authoritativeHost)
          : reference.repository === projectRepository?.repository
            ? (projectRepository?.host ?? authoritativeHost)
            : "github.com"
        : authoritativeHost;

      const key = reference.repository
        ? `${reference.repository}#${reference.number}`
        : `#${reference.number}`;
      const isCurrentPullRequest =
        navigation !== null &&
        referenceRepository === navigation.repository.toLowerCase() &&
        reference.number === navigation.number;
      references.set(
        key,
        isCurrentPullRequest
          ? navigation.url
          : buildGitHubIssueReferenceUrl({
              repository: referenceRepository,
              number: reference.number,
              host: referenceHost,
            }),
      );
    }

    const stabilized = stabilizeStringMap(references, githubReferencesRef.current);
    githubReferencesRef.current = stabilized;
    return stabilized;
  }, [
    currentProject?.repositoryIdentity?.canonicalKey,
    currentProject?.repositoryIdentity?.name,
    currentProject?.repositoryIdentity?.owner,
    currentProject?.repositoryIdentity?.provider,
    currentThread?.pullRequest?.url,
    normalizedText,
  ]);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, linkBaseDir);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, linkBaseDir, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    return buildFileParentSuffixByPath(
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
        return (
          <MarkdownThreadLink threadRef={linkedThreadRef} className={props.className} preserveLabel>
            {props.children}
          </MarkdownThreadLink>
        );
      }

      const linkedPullRequestUrl = resolveMarkdownPullRequestUrl(node?.properties);
      if (linkedPullRequestUrl) {
        return (
          <MarkdownPullRequestLink
            href={linkedPullRequestUrl}
            {...(threadRef ? { threadRef } : {})}
            {...props}
          >
            {props.children}
          </MarkdownPullRequestLink>
        );
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
          {...(cwd ? { cwd } : {})}
          {...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {})}
          className={props.className}
        />
      );
    },
    [cwd, fileLinkParentSuffixByPath, markdownFileLinkMetaByHref, resolvedTheme, threadRef],
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
        const fileLinkMeta = resolveChatInlineCode(codeText);
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
              {...(threadRef ? { threadRef } : {})}
              {...(cwd ? { cwd } : {})}
              {...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {})}
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
    [resolveChatInlineCode, cwd, resolvedTheme, threadRef],
  );
  const markdownListItem = useCallback(
    ({ node, ...props }: MarkdownFunctionComponentProps<"li">) => {
      const listItemStart = node?.position?.start.offset;
      const markerOffset =
        typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
      return <li {...props} data-task-marker-offset={markerOffset ?? undefined} />;
    },
    [text],
  );
  const markdownTaskInput = useCallback(
    ({
      node: _node,
      type,
      checked,
      disabled,
      ...props
    }: MarkdownFunctionComponentProps<"input">) => {
      if (type !== "checkbox" || !onTaskListChange) {
        return (
          <input
            {...props}
            type={type}
            checked={checked}
            disabled={disabled}
            readOnly={type === "checkbox"}
          />
        );
      }
      return (
        <input
          {...props}
          type="checkbox"
          name="markdown-task"
          aria-label="Toggle task"
          checked={checked}
          onChange={(event) => {
            const markerOffset = Number(
              event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
            );
            if (!Number.isSafeInteger(markerOffset)) return;
            onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
          }}
        />
      );
    },
    [onTaskListChange],
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      ...markdownComponentsWithoutRuntimeState,
      a: markdownAnchor,
      code: markdownCode,
      pre: markdownPre,
      li: markdownListItem,
      input: markdownTaskInput,
    }),
    [markdownAnchor, markdownCode, markdownPre, markdownListItem, markdownTaskInput],
  );
  // Stable plugin array: react-markdown re-tokenizes when the array identity
  // changes, so factory plugins must be memoized across streaming renders.
  // threadRef is a stable context object upstream; depend on its primitives.
  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      remarkClassifyChatLinks({
        ...(threadRef ? { environmentId: threadRef.environmentId } : {}),
        baseOrigin:
          typeof window === "undefined"
            ? "http://localhost"
            : (window.location?.origin ?? "http://localhost"),
        trustedOrigins,
        githubReferences,
      }),
      remarkTagInlineCode(resolveChatInlineCode),
    ],
    [resolveChatInlineCode, githubReferences, threadRef?.environmentId, trustedOrigins],
  );

  return (
    <div
      className={cn("chat-markdown w-full min-w-0 leading-relaxed text-foreground/80", className)}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}

function ChatMarkdownWithWorkspaceEntries({
  threadRef,
  cwd,
  ...rest
}: ChatMarkdownProps & { readonly threadRef: ScopedThreadRef; readonly cwd: string }) {
  // The query is cached per cwd, so per-message cost is a filtered scan only when
  // a bare basename is actually encountered.
  const workspaceEntriesQuery = useProjectEntriesQuery(threadRef.environmentId, cwd);
  const workspaceEntries = useMemo(
    () => workspaceEntriesQuery.data?.entries ?? EMPTY_WORKSPACE_ENTRIES,
    [workspaceEntriesQuery.data],
  );
  return (
    <ChatMarkdownView
      {...rest}
      threadRef={threadRef}
      cwd={cwd}
      workspaceEntries={workspaceEntries}
    />
  );
}

function ChatMarkdown(props: ChatMarkdownProps) {
  const { threadRef, cwd } = props;
  // Skip the workspace file index when there is no thread/cwd to resolve
  // against; bare basenames fall back to cwd-only resolution in the view.
  if (threadRef && cwd) {
    return <ChatMarkdownWithWorkspaceEntries {...props} threadRef={threadRef} cwd={cwd} />;
  }
  return <ChatMarkdownView {...props} workspaceEntries={EMPTY_WORKSPACE_ENTRIES} />;
}

export default memo(ChatMarkdown);
