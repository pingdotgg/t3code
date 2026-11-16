import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
} from "@t3tools/shared/markdownLinks";
import {
  ASSISTANT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import type { Root } from "mdast";
import { createContext, use } from "react";
import { defaultUrlTransform } from "react-markdown";

import ChatMarkdown from "../../components/ChatMarkdown";
import { nodeToPlainText } from "../../components/chat/MarkdownCodeBlock.logic";
import { createMarkdownRenderer } from "../../components/chat/markdownRenderer";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../../markdown-links";
import { remarkEndLinksAtCjkPunctuation } from "../cjkLinkEnd";
import {
  hostFileAnchorHref,
  hostFileLinkHref,
  hostFileLinkLabel,
  useHostFileOrigins,
} from "../hostFileLinks";

interface LinkScope {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}

/** Where file references in a slot resolve and open. Without it they stay code and links. */
export const DashboardLinkScope = createContext<LinkScope | null>(null);

interface SlotCopy {
  readonly text: string;
  /** Every file path in the slot's current and read text, so both copies label chips alike. */
  readonly filePaths: readonly string[];
  readonly hostFileOrigins: readonly string[];
}

const SlotCopyContext = createContext<SlotCopy>({ text: "", filePaths: [], hostFileOrigins: [] });

function remarkUnwrapSoleParagraph() {
  return (tree: Root) => {
    const [only] = tree.children;
    if (tree.children.length === 1 && only?.type === "paragraph") tree.children = only.children;
  };
}

// A chip sits inside the slot's own paragraph, so its markdown must not add another `<p>`.
const CHIP_PLUGINS = [remarkUnwrapSoleParagraph];

/**
 * Chat's own file chip. `markdown` is a code span or an empty-label link built here, never
 * text from the slot, so nothing in it can suspend or parse differently from the slot.
 */
function ChatFileChip(props: { readonly markdown: string; readonly scope: LinkScope }) {
  const { filePaths } = use(SlotCopyContext);
  return (
    <ChatMarkdown
      inline
      text={props.markdown}
      cwd={props.scope.cwd}
      threadRef={props.scope.threadRef}
      extraRemarkPlugins={CHIP_PLUGINS}
      fileLinkPeerPaths={filePaths}
    />
  );
}

function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes a parsed destination so that the chip's own parse reads it back unchanged. */
function linkDestination(href: string): string {
  return href.replace(/[\\<>&]/g, "\\$&");
}

function normalizeHref(href: string): string {
  const destination = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(destination) ?? destination;
}

function slotFilePaths(
  texts: readonly string[],
  cwd: string | undefined,
  hostFileOrigins: readonly string[],
): string[] {
  const paths = new Set<string>();
  for (const text of texts) {
    for (const href of extractMarkdownLinkHrefs(text)) {
      const linkPath = hostFileLinkHref(normalizeHref(href), hostFileOrigins);
      const path = resolveMarkdownFileLinkMeta(linkPath, cwd)?.filePath;
      if (path) paths.add(path);
    }
    for (const span of extractInlineCodeSpans(text)) {
      const path = resolveInlineCodeFileLinkMeta(span, cwd)?.filePath;
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

const renderMarkdown = createMarkdownRenderer({
  remarkPlugins: [...ASSISTANT_MARKDOWN_REMARK_PLUGINS, remarkEndLinksAtCjkPunctuation],
  rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
  components: {
    a: function DashboardLink({ node, children, ...props }) {
      const scope = use(DashboardLinkScope);
      const { text, hostFileOrigins } = use(SlotCopyContext);
      const href = props.href ? normalizeHref(props.href) : "";
      const linkPath = hostFileAnchorHref(href, node, hostFileOrigins);
      const fileLinkMeta =
        scope !== null && href !== "" ? resolveMarkdownFileLinkMeta(linkPath, scope.cwd) : null;
      if (scope === null || fileLinkMeta === null) {
        return (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      const label = nodeToPlainText(children);
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
      const copyMarkdown =
        source.startsWith("[") && source.includes("](")
          ? source
          : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${href})`;
      const chip = <ChatFileChip markdown={`[](<${linkDestination(href)}>)`} scope={scope} />;
      return isMarkdownFileLinkLabel(hostFileLinkLabel(label, hostFileOrigins), linkPath) ? (
        <span data-markdown-copy={copyMarkdown}>{chip}</span>
      ) : (
        <span data-markdown-copy={copyMarkdown}>
          <span className="whitespace-normal">{children} </span>
          {chip}
        </span>
      );
    },
    code: function DashboardCode({ node, children, ...props }) {
      const scope = use(DashboardLinkScope);
      if (scope !== null && node?.properties?.dataInlineCode != null) {
        const codeText = nodeToPlainText(children);
        if (resolveInlineCodeFileLinkMeta(codeText, scope.cwd) !== null) {
          return <ChatFileChip markdown={codeSpan(codeText)} scope={scope} />;
        }
      }
      return <code {...props}>{children}</code>;
    },
  },
  urlTransform: (url) =>
    rewriteMarkdownFileUriHref(url) ??
    (isWindowsDrivePathHref(url) ? url : defaultUrlTransform(url)),
});

/**
 * A slot's markdown: chat's syntax and file chips, rendered synchronously. `pairedText` is the
 * slot's other copy, current or read.
 */
export function DashboardMarkdown(props: { readonly text: string; readonly pairedText?: string }) {
  const scope = use(DashboardLinkScope);
  const hostFileOrigins = useHostFileOrigins(scope?.threadRef.environmentId ?? null);
  const filePaths = slotFilePaths(
    [props.text, props.pairedText ?? ""],
    scope?.cwd,
    hostFileOrigins,
  );
  return (
    <SlotCopyContext value={{ text: props.text, filePaths, hostFileOrigins }}>
      {renderMarkdown(props.text, true)}
    </SlotCopyContext>
  );
}
