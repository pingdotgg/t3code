import {
  matchInlineSkills,
  formatProviderSkillDisplayName,
  type InlineSkill,
} from "./inlineSkills.ts";
import {
  artifactTemplateFromHastProperties,
  renderCodexFileCitationsAsMarkdown,
} from "./codexMarkdownDirectives.ts";
import { codexArtifactTemplatePresentationLabel } from "./codexArtifactTemplates.ts";
import {
  buildFileLinkParentSuffixByPath,
  splitFilePathPosition,
  fileLinkLabel,
} from "./fileLinks.ts";
import {
  isMarkdownFileLinkLabel,
  extractMarkdownLinkHrefs,
  extractInlineCodeSpans,
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLinkTarget,
} from "./markdownLinks.ts";
import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { assistantCitationLabel, parseAssistantCitationHref } from "./assistantCitations.ts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  shouldPreserveAssistantLineBreaks,
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
const assistantBreaksProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
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
  readonly properties?: {
    readonly href?: unknown;
    readonly src?: unknown;
    readonly dataInlineCode?: unknown;
  };
  readonly children?: ReadonlyArray<TextTree>;
}

/** Uses the renderer's Markdown transforms, without mounting folded/virtualized rows. */
function markdownThreadFindText(
  markdown: string,
  userMessage = false,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
  lineBreaks = false,
): string[] {
  const processor = userMessage
    ? userProcessor
    : lineBreaks
      ? assistantBreaksProcessor
      : assistantProcessor;
  const tree = processor.runSync(processor.parse(markdown));
  const paths = [
    ...extractMarkdownLinkHrefs(renderCodexFileCitationsAsMarkdown(markdown)),
    ...extractInlineCodeSpans(markdown).flatMap((span) => inlineCodeFilePathCandidate(span) ?? []),
  ].flatMap((href) => {
    const target = resolveMarkdownFileLinkTarget(href, cwd);
    return target ? [splitFilePathPosition(target).path] : [];
  });
  const parentSuffixes = buildFileLinkParentSuffixByPath(paths);
  const segments: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: TextTree, inPre = false, inlineSkills = false) => {
    const href = node.properties?.href ?? node.properties?.src;
    if (userMessage && typeof href === "string" && parseComposerContextHref(href)) {
      flush();
      return;
    }
    const citation =
      node.tagName === "a" && typeof href === "string" ? parseAssistantCitationHref(href) : null;
    if (citation) {
      // Matches the citation chip, which shows its label instead of the link text.
      text += assistantCitationLabel(citation);
      return;
    }
    {
      let candidate: string | null = null;
      if (node.tagName === "a" && typeof href === "string") {
        candidate = href;
      } else if (
        node.tagName === "code" &&
        !inPre &&
        node.properties?.dataInlineCode !== undefined
      ) {
        candidate = inlineCodeFilePathCandidate(
          (node.children ?? []).map((child) => child.value ?? "").join(""),
        );
      }
      const target = candidate ? resolveMarkdownFileLinkTarget(candidate, cwd) : null;
      if (target) {
        const labelText = (node: TextTree): string =>
          node.value ?? (node.children ?? []).map(labelText).join("");
        const label = labelText(node);
        if (node.tagName === "a" && candidate && !isMarkdownFileLinkLabel(label, candidate))
          text += `${label} `;
        text += fileLinkLabel(splitFilePathPosition(target), parentSuffixes);
        return;
      }
    }
    const template = artifactTemplateFromHastProperties(node.properties);
    if (template) {
      // Matches the card's visible text; its action button is not indexed.
      flush();
      segments.push(
        template.displayName,
        codexArtifactTemplatePresentationLabel(template.artifactKind),
      );
      return;
    }
    const block = THREAD_FIND_BLOCK_TAGS.has(node.tagName ?? "");
    if (block) flush();
    if (node.type === "text" || (userMessage && node.type === "raw")) {
      let value = node.value ?? "";
      if (inlineSkills) {
        let cursor = 0;
        let rendered = "";
        for (const { start, end, skill } of matchInlineSkills(value, skills)) {
          rendered += value.slice(cursor, start) + formatProviderSkillDisplayName(skill);
          cursor = end;
        }
        value = rendered + value.slice(cursor);
      }
      text += inPre ? value : value.replace(/\r?\n/g, " ");
    }
    const renderSkills =
      node.tagName === "code" || node.tagName === "a"
        ? false
        : inlineSkills || node.tagName === "p" || node.tagName === "li";
    for (const child of node.children ?? [])
      visit(child, inPre || node.tagName === "pre", renderSkills);
    if (block) flush();
  };
  visit(tree);
  flush();
  return segments;
}

/** Plans render `$skill` tokens literally (no skill chips), so they are indexed as written. */
export function searchablePlanSegments(markdown: string, cwd?: string): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindText(stripDisplayedPlanMarkdown(markdown), false, cwd, []),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "context">,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
): readonly string[] | null {
  if (message.role === "user") {
    const text = message.context ? message.text : upgradeLegacyContextMessage(message.text).text;
    return markdownThreadFindText(text, true, cwd, skills);
  }
  if (message.role !== "assistant") return null;
  return markdownThreadFindText(
    message.text || (message.streaming ? "" : "(empty response)"),
    false,
    cwd,
    skills,
    shouldPreserveAssistantLineBreaks(message.text),
  );
}
