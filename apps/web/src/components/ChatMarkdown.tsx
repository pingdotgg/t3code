import { CheckIcon, CopyIcon } from "lucide-react";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
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
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { useTheme } from "../hooks/useTheme";
import {
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE } from "../hooks/useMobileEdgeSwipe";
import { cn } from "../lib/utils";
import { openPathInPreferredEditorOrFilePreview } from "../workspaceFilePreview";
import { resolveWorkspaceFilePreviewTarget } from "../workspaceFilePreview";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import {
  isWorkspaceImagePreviewPath,
  resolveWorkspaceImagePreviewUrl,
} from "../workspaceImagePreview";
import {
  createCodeHighlightCacheKey,
  getCachedHighlightedCodeHtml,
  getCodeHighlighterPromise,
  highlightCodeToHtml,
  resolveCodeHighlightLanguageFromFenceClass,
  setCachedHighlightedCodeHtml,
} from "../codeHighlighting";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";

const CHAT_MARKDOWN_REMARK_PLUGINS = [remarkGfm];

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
  environmentId?: EnvironmentId | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

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

// Inline code (and the inner `<code>` of fenced blocks) renders through here so
// a horizontal drag scrolls/selects the snippet instead of moving a panel.
function MarkdownInlineCode({
  children,
  node: _node,
  ...props
}: React.ComponentProps<"code"> & { node?: unknown }): React.ReactElement {
  return (
    <code {...props} {...{ [MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE]: "true" }}>
      {children}
    </code>
  );
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
    (onlyChild.type !== "code" && onlyChild.type !== MarkdownInlineCode)
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

// Horizontal scroll position of each code block's <pre>, keyed by code content so it
// survives the block being unmounted/remounted. That happens for several reasons outside
// this component's control: the markdown `components` map is recreated whenever ChatMarkdown
// re-renders with new props (giving the inline `pre` renderer a new identity, which remounts
// the whole block subtree), the syntax-highlight DOM is swapped from fallback to highlighted,
// and the surrounding message row can be recycled by the virtualized timeline. Without this,
// any of those drops a user's horizontal scroll back to the origin.
const codeBlockHorizontalScrollByKey = new Map<string, number>();

function codeBlockScrollKey(code: string): string {
  return `${fnv1a32(code).toString(36)}:${code.length}`;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = useMemo(() => codeBlockScrollKey(code), [code]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const restoreScroll = () => {
      const pre = container.querySelector<HTMLElement>("pre");
      if (!pre) {
        return;
      }
      const saved = codeBlockHorizontalScrollByKey.get(scrollKey);
      if (saved != null && pre.scrollLeft !== saved) {
        pre.scrollLeft = saved;
      }
    };
    // Restore now (cached highlight renders synchronously) and again whenever the inner
    // DOM is replaced (suspense fallback → highlighted output).
    restoreScroll();
    const observer = new MutationObserver(restoreScroll);
    observer.observe(container, { childList: true, subtree: true });
    // scroll doesn't bubble, but capture-phase listeners on ancestors still receive it.
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === "PRE") {
        codeBlockHorizontalScrollByKey.set(scrollKey, target.scrollLeft);
      }
    };
    container.addEventListener("scroll", handleScroll, true);
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", handleScroll, true);
    };
  }, [scrollKey]);
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
    <div
      ref={containerRef}
      className="chat-markdown-codeblock leading-snug"
      {...{ [MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE]: "true" }}
    >
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

export function splitCodeBlockLinesForStableFallback(code: string): readonly string[] {
  return code.split("\n");
}

export function StableCodeBlockFallback({
  code,
  themeName,
}: {
  readonly code: string;
  readonly themeName: DiffThemeName;
}) {
  const lines = splitCodeBlockLinesForStableFallback(code);
  let nextLineStartOffset = 0;

  return (
    <div className="chat-markdown-shiki chat-markdown-shiki-fallback">
      <pre className={`shiki ${themeName}`} tabIndex={0} data-code-highlight-state="fallback">
        <code>
          {lines.map((line, index) => {
            const lineStartOffset = nextLineStartOffset;
            nextLineStartOffset += line.length + 1;
            return (
              <React.Fragment key={`${lineStartOffset}:${line}`}>
                <span className="line">{line}</span>
                {index < lines.length - 1 ? "\n" : null}
              </React.Fragment>
            );
          })}
        </code>
      </pre>
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
  const language = resolveCodeHighlightLanguageFromFenceClass(className);
  const cacheKey = createCodeHighlightCacheKey(code, language, themeName, "chat-markdown");
  const cachedHighlightedHtml = !isStreaming ? getCachedHighlightedCodeHtml(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        data-code-highlight-state="highlighted"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
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
  const highlighter = use(getCodeHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    return highlightCodeToHtml({ highlighter, code, language, themeName });
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      setCachedHighlightedCodeHtml(cacheKey, highlightedHtml, code);
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div
      className="chat-markdown-shiki"
      data-code-highlight-state="highlighted"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
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
  cwd?: string | undefined;
  environmentId?: EnvironmentId | undefined;
  className?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";
const MARKDOWN_ATTACHMENTS_ROUTE_PREFIX = "/attachments/";

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

function basenameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return separatorIndex >= 0 ? normalizedPath.slice(separatorIndex + 1) : normalizedPath;
}

function resolveEnvironmentPathUrl(input: {
  environmentId: EnvironmentId | undefined;
  pathname: string;
  searchParams?: Record<string, string>;
}): string | null {
  if (!input.environmentId) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: input.pathname,
      ...(input.searchParams ? { searchParams: input.searchParams } : {}),
    });
  } catch {
    return null;
  }
}

function resolveMarkdownImagePreview(input: {
  src: string | undefined;
  alt: string | undefined;
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
}): { src: string; name: string } | null {
  if (!input.src) {
    return null;
  }

  const href = normalizeMarkdownLinkHrefKey(input.src);
  if (href.startsWith(MARKDOWN_ATTACHMENTS_ROUTE_PREFIX)) {
    const resolvedSrc = resolveEnvironmentPathUrl({
      environmentId: input.environmentId,
      pathname: href,
    });
    return resolvedSrc ? { src: resolvedSrc, name: input.alt || basenameFromPath(href) } : null;
  }

  const fileLinkMeta = resolveMarkdownFileLinkMeta(href, input.cwd);
  if (!fileLinkMeta || !input.cwd || !input.environmentId) {
    return null;
  }
  if (!isWorkspaceImagePreviewPath(fileLinkMeta.filePath)) {
    return null;
  }

  const previewTarget = resolveWorkspaceFilePreviewTarget({
    environmentId: input.environmentId,
    cwd: input.cwd,
    targetPath: fileLinkMeta.targetPath,
    displayPath: fileLinkMeta.displayPath,
  });
  if (!previewTarget) {
    return null;
  }

  const resolvedSrc = resolveWorkspaceImagePreviewUrl({
    environmentId: previewTarget.environmentId,
    cwd: previewTarget.cwd,
    relativePath: previewTarget.relativePath,
  });
  return resolvedSrc
    ? { src: resolvedSrc, name: input.alt || fileLinkMeta.basename || previewTarget.displayPath }
    : null;
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  label,
  theme,
  cwd,
  environmentId,
  className,
}: MarkdownFileLinkProps) {
  const handleOpen = useCallback(() => {
    void openPathInPreferredEditorOrFilePreview({
      targetPath,
      cwd,
      environmentId,
      displayPath,
    }).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [cwd, displayPath, environmentId, targetPath]);

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
          { id: "open", label: "Open file" },
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
    previous.cwd === next.cwd &&
    previous.environmentId === next.environmentId &&
    previous.className === next.className
  );
}

function ChatMarkdown({
  text,
  cwd,
  environmentId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onImageExpand,
}: ChatMarkdownProps) {
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
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      li({ node: _node, children, ...props }) {
        return <li {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</li>;
      },
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
            cwd={cwd}
            environmentId={environmentId}
            className={props.className}
          />
        );
      },
      img({ node: _node, src, alt }) {
        const image = resolveMarkdownImagePreview({
          src,
          alt,
          cwd,
          environmentId,
        });
        if (!image) {
          return null;
        }

        const preview = {
          images: [{ src: image.src, name: image.name }],
          index: 0,
        } satisfies ExpandedImagePreview;

        return (
          <button
            type="button"
            className="chat-markdown-image-button"
            aria-label={`Preview ${image.name}`}
            onClick={() => onImageExpand?.(preview)}
          >
            <img
              src={image.src}
              alt={alt ?? image.name}
              className="chat-markdown-image"
              loading="lazy"
            />
          </button>
        );
      },
      code: MarkdownInlineCode,
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return (
            <pre {...props} {...{ [MOBILE_EDGE_SWIPE_BLOCK_ATTRIBUTE]: "true" }}>
              {children}
            </pre>
          );
        }

        const stableFallback = (
          <StableCodeBlockFallback code={codeBlock.code} themeName={diffThemeName} />
        );

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={stableFallback}>
              <Suspense fallback={stableFallback}>
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
    }),
    [
      diffThemeName,
      fileLinkParentSuffixByPath,
      environmentId,
      isStreaming,
      markdownFileLinkMetaByHref,
      onImageExpand,
      cwd,
      resolvedTheme,
      skills,
    ],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
