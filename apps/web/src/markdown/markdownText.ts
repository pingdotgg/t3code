import { decodeHTMLStrict } from "entities";
import {
  codexArtifactTemplatePresentationLabel,
  resolveCodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  codexFileCitationMarkdown,
  resolveCodexFileCitationLink,
} from "@t3tools/shared/codexFileCitations";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { codexDirectiveSources, type CodexDirectiveSource } from "./wordsHast";

const CODEX_DIRECTIVE = /:codex-file-citation|:codex-followup|::artifact-template/;

/** Replaces each directive with what `replacement` returns for it; undefined keeps it. */
function replaceDirectives(
  markdown: string,
  replacement: (directive: CodexDirectiveSource) => string | undefined,
): string {
  if (!CODEX_DIRECTIVE.test(markdown)) return markdown;
  let rendered = markdown;
  const changes: Array<{ start: number; delta: number }> = [];
  const directives = codexDirectiveSources(markdown).sort(
    (left, right) => right.start - left.start,
  );
  for (const directive of directives) {
    // Consume child edits so this directive's original end and label still locate the rendered text.
    let delta = 0;
    while (changes.length && changes.at(-1)!.start < directive.end) {
      delta += changes.pop()!.delta;
    }
    let label = "";
    if (directive.label) {
      const labelStart = markdown.indexOf("[", directive.start) + 1;
      label = rendered.slice(labelStart, labelStart + directive.label.length + delta);
    }
    const value =
      replacement({ ...directive, label }) ??
      rendered.slice(directive.start, directive.end + delta);
    rendered = rendered.slice(0, directive.start) + value + rendered.slice(directive.end + delta);
    changes.push({
      start: directive.start,
      delta: value.length - (directive.end - directive.start),
    });
  }
  return rendered;
}

/** A file citation as the Markdown link it shows as, and a follow-up as its label. */
function inlineDirectiveMarkdown(directive: CodexDirectiveSource): string | undefined {
  if (directive.name === "codex-file-citation") {
    const citation = directive.inLink ? null : resolveCodexFileCitationLink(directive.attributes);
    return citation ? codexFileCitationMarkdown(citation) : undefined;
  }
  if (directive.name === "codex-followup") {
    return directive.attributes.prompt?.trim() && directive.label.trim()
      ? directive.label
      : undefined;
  }
  return undefined;
}

export function renderCodexInlineDirectivesAsMarkdown(markdown: string): string {
  return replaceDirectives(markdown, inlineDirectiveMarkdown);
}

/** What copying a message writes: inline directives as Markdown, a template as its name. */
export function renderCodexDirectivesForCopy(markdown: string): string {
  return replaceDirectives(markdown, (directive) => {
    if (directive.name !== "artifact-template") return inlineDirectiveMarkdown(directive);
    const template = resolveCodexArtifactTemplate(directive.attributes);
    return template
      ? `${template.displayName} (${codexArtifactTemplatePresentationLabel(template.artifactKind)})`
      : undefined;
  });
}

/** A link destination as written, with its character references and escapes resolved. */
export function decodeMarkdownLinkEscapes(href: string): string {
  const decoded = href.includes("&") ? decodeHTMLStrict(href) : href;
  return isWindowsAbsolutePath(decoded)
    ? decoded
    : href.replace(
        /\\([!-/:-@[-`{-~])|&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]*);/g,
        (match, escaped: string | undefined) => escaped ?? decodeHTMLStrict(match),
      );
}
