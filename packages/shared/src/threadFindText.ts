import { parseReviewCommentMessageSegments } from "./reviewCommentText.ts";
import type { OrchestrationMessage } from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";
import { deriveDisplayedUserMessageContent } from "./visibleMessageText.ts";
import { splitUserMessageTerminalContexts } from "./userMessageTerminalContexts.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

// Inline wrappers (including Shiki token spans) must not split a search phrase.
export const THREAD_FIND_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const assistantProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
const userProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(remarkRehype, { allowDangerousHtml: true });

interface TextTree {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<TextTree>;
}

/** Uses the renderer's Markdown transforms, without mounting folded/virtualized rows. */
function markdownThreadFindText(markdown: string, userMessage = false): string[] {
  const processor = userMessage ? userProcessor : assistantProcessor;
  const tree = processor.runSync(processor.parse(markdown));
  const segments: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: TextTree, inPre = false) => {
    const block = THREAD_FIND_BLOCK_TAGS.has(node.tagName ?? "");
    if (block) flush();
    if (node.type === "text" || (userMessage && node.type === "raw")) {
      text += inPre ? (node.value ?? "") : (node.value ?? "").replace(/\r?\n/g, " ");
    }
    for (const child of node.children ?? []) visit(child, inPre || node.tagName === "pre");
    if (block) flush();
  };
  visit(tree);
  flush();
  return segments;
}

export function searchablePlanSegments(markdown: string): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindText(stripDisplayedPlanMarkdown(markdown)),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationMessage, "role" | "text" | "streaming">,
): readonly string[] | null {
  if (message.role === "user") {
    const { visibleText, terminalContexts } = deriveDisplayedUserMessageContent(message.text);
    const review = parseReviewCommentMessageSegments(visibleText);
    if (review.some((segment) => segment.kind === "review-comment")) {
      return review.flatMap((segment) =>
        segment.kind === "text"
          ? markdownThreadFindText(segment.text.trim(), true)
          : [segment.comment.text.replace(/\r?\n/g, " ")],
      );
    }
    const segments = splitUserMessageTerminalContexts(visibleText, terminalContexts);
    if (segments === null) return markdownThreadFindText(visibleText, true);
    return segments.flatMap((segment) =>
      segment.kind === "text" ? markdownThreadFindText(segment.text, true) : [],
    );
  }
  if (message.role !== "assistant") return null;
  return markdownThreadFindText(message.text || (message.streaming ? "" : "(empty response)"));
}
