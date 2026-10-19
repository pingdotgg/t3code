import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipPresentation } from "./composerChipPresentation";
import { resolveMarkdownInlineCodePresentation, type MarkdownFileIcon } from "./markdownLinks";
import type { SelectableMarkdownSkill } from "../native/SelectableMarkdownText.types";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";

const CONTEXT_ICONS: Readonly<Record<string, MarkdownFileIcon>> = {
  photo: "image",
  "play.rectangle": "video",
  terminal: "bash",
  "cursorarrow.click": "react",
  "text.bubble": "markdown",
  "git-pull-request": "git",
  cube: "mcp",
  doc: "default",
};

export function enrichedContextLinkPresentation(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
) {
  const reference = parseComposerContextHref(href);
  if (!reference) return undefined;
  const record = records?.find((candidate) => candidate.contextId === reference.contextId);
  const presentation = contextChipPresentation(reference.kind, record);
  return {
    color: presentation.accent,
    icon: CONTEXT_ICONS[presentation.symbol] ?? "default",
  };
}

export function enrichedLinkVariantPattern(url: string) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function enrichedInlineFileLinkRegex(markdown: string) {
  const paths = new Set<string>();
  for (const piece of markdown.split(/`+/)) {
    const content = piece.trim();
    if (resolveMarkdownInlineCodePresentation(content)) paths.add(content);
  }
  return paths.size > 0
    ? new RegExp([...paths].map(enrichedLinkVariantPattern).join("|"))
    : undefined;
}

export function enrichedSkillLinkRegex(skills?: ReadonlyArray<SelectableMarkdownSkill>) {
  const names = [...new Set(skills?.map((skill) => skill.name) ?? [])].filter(Boolean);
  if (names.length === 0) return null;
  names.sort((a, b) => b.length - a.length);
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?<!\\p{Sc})\\p{Sc}(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`,
    "u",
  );
}

export function enrichedSkillDisplayName(skill: SelectableMarkdownSkill) {
  return (
    skill.displayName?.trim() ||
    skill.name
      .split(/[\s:_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export function enrichedSkillReference(
  url: string,
  skills?: ReadonlyArray<SelectableMarkdownSkill>,
) {
  const match = /^\p{Sc}(.+)$/u.exec(url);
  return match ? skills?.find((skill) => skill.name === match[1]) : undefined;
}
