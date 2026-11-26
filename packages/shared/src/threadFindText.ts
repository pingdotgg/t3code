import { shouldPreserveAssistantLineBreaks } from "./assistantInsights.ts";
import { THREAD_FIND_BLOCK_TAGS } from "./threadFindBlockTags.ts";
import {
  matchInlineSkills,
  formatProviderSkillDisplayName,
  type InlineSkill,
} from "./inlineSkills.ts";
import { renderCodexInlineDirectivesAsMarkdown } from "./codexMarkdownDirectives.ts";
import {
  artifactTemplateFromHastProperties,
  codexArtifactTemplatePresentationLabel,
} from "./codexArtifactTemplates.ts";
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "./fileLinks.ts";
import {
  classifyMarkdownImageSource,
  isMarkdownFileLinkLabel,
  extractMarkdownLinkHrefs,
  extractInlineCodeSpans,
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLink,
  shouldRenderMarkdownImageAsFileLink,
} from "./markdownLinks.ts";
import { mediaKindFromPath } from "./mediaPreview.ts";
import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import {
  isAttachmentOnlyBootstrapPrompt,
  parseComposerContextHref,
} from "./composerContextReferences.ts";
import { parseAssistantCitationHref } from "./assistantCitations.ts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  remarkAssistantInsights,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_USER_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownImageSource,
  decodeMarkdownLinkEscapes,
  type ChatMarkdownImageProperties,
} from "./markdownPipeline.ts";

// Inline wrappers (including Shiki token spans) must not split a search phrase.

function assistantTextProcessor(lineBreaks = false, renderInsights = false) {
  return unified()
    .use(remarkParse)
    .use(renderInsights ? [remarkAssistantInsights] : [])
    .use(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
}
const assistantProcessor = assistantTextProcessor();
const assistantBreaksProcessor = assistantTextProcessor(true);
const insightProcessor = assistantTextProcessor(false, true);
const insightBreaksProcessor = assistantTextProcessor(true, true);
const userProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(CHAT_USER_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true });

interface TextTree {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: ChatMarkdownImageProperties & {
    readonly href?: unknown;
    readonly dataInlineCode?: unknown;
  };
  readonly children?: ReadonlyArray<TextTree>;
}

function markdownThreadFindText(
  markdown: string,
  {
    userMessage = false,
    cwd,
    skills = [],
    lineBreaks = false,
    renderInsights = false,
    theme,
  }: {
    userMessage?: boolean;
    cwd: string | undefined;
    skills?: readonly InlineSkill[];
    lineBreaks?: boolean;
    renderInsights?: boolean;
    theme: "dark" | "light" | undefined;
  },
): string[] {
  const processor = userMessage
    ? userProcessor
    : lineBreaks
      ? assistantBreaksProcessor
      : assistantProcessor;
  const renderer = renderInsights
    ? lineBreaks
      ? insightBreaksProcessor
      : insightProcessor
    : processor;
  const tree = renderer.runSync(renderer.parse(markdown), markdown);
  const paths = [
    ...extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(markdown)).map(
      decodeMarkdownLinkEscapes,
    ),
    ...extractInlineCodeSpans(markdown).flatMap((span) => inlineCodeFilePathCandidate(span) ?? []),
  ].flatMap((href) => {
    const resolved = resolveMarkdownFileLink(href, cwd);
    return resolved ? [resolved.position.path] : [];
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
      // The quote card is not searched, and it splits the text before it from its comment.
      flush();
      text += (citation.comment ?? "").replace(/\r?\n/g, " ");
      return;
    }
    {
      let candidate: string | null = null;
      if (node.tagName === "a" && typeof href === "string") {
        candidate = href;
      } else if (node.tagName === "img") {
        const source = chatMarkdownImageSource(node.properties, theme);
        if (source) {
          const { authoredSrc, classifiedSrc } = source;
          if (
            shouldRenderMarkdownImageAsFileLink(
              classifyMarkdownImageSource(classifiedSrc, cwd),
              mediaKindFromPath(classifiedSrc),
            )
          ) {
            candidate = authoredSrc;
          }
        }
      } else if (
        node.tagName === "code" &&
        !inPre &&
        node.properties?.dataInlineCode !== undefined
      ) {
        candidate = inlineCodeFilePathCandidate(
          (node.children ?? []).map((child) => child.value ?? "").join(""),
        );
      }
      const resolved = candidate ? resolveMarkdownFileLink(candidate, cwd) : null;
      if (candidate && resolved) {
        const labelText = (node: TextTree): string =>
          node.value ?? (node.children ?? []).map(labelText).join("");
        const label = labelText(node);
        if (node.tagName === "a" && !isMarkdownFileLinkLabel(label, candidate)) text += `${label} `;
        text += fileLinkLabel(resolved.position, parentSuffixes);
        return;
      }
    }
    const template = artifactTemplateFromHastProperties(node.properties);
    if (template) {
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
      text += inPre ? value : value.replace(/\r\n|\r|\n/g, " ");
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
export function searchablePlanSegments(
  markdown: string,
  cwd?: string,
  theme?: "dark" | "light",
): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindText(stripDisplayedPlanMarkdown(markdown), { cwd, theme }),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "context">,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
  theme?: "dark" | "light",
): readonly string[] | null {
  if (message.role === "user") {
    // Clients hide this prompt, so find must not match text nobody can see.
    if (isAttachmentOnlyBootstrapPrompt(message.text)) return [];
    const text = message.context ? message.text : upgradeLegacyContextMessage(message.text).text;
    return markdownThreadFindText(text, { userMessage: true, cwd, skills, theme });
  }
  if (message.role !== "assistant") return null;
  return markdownThreadFindText(message.text || (message.streaming ? "" : "(empty response)"), {
    cwd,
    skills,
    lineBreaks: shouldPreserveAssistantLineBreaks(message.text),
    renderInsights: true,
    theme,
  });
}
