import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipPresentation } from "./composerChipPresentation";
import type { MarkdownFileIcon } from "./markdownLinks";
import type { SelectableMarkdownSkill } from "../native/SelectableMarkdownText.types";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { serializeComposerSkillToken } from "@t3tools/shared/composerInlineTokens";

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

export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

export function enrichedSkillLinkRegex(skills?: ReadonlyArray<SelectableMarkdownSkill>) {
  const names = [...new Set(skills?.map((skill) => skill.name) ?? [])].filter(Boolean);
  if (names.length === 0) return null;
  const sources = [...new Set(names.flatMap(skillSources))];
  sources.sort((a, b) => b.length - a.length);
  const alternatives = sources.map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?<!\\p{Sc})\\p{Sc}(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`,
    "u",
  );
}

/**
 * Composers quote names that are not one bare word, such as `$"Poteto Mode"`, and escape
 * quotes, backslashes, and line breaks inside them. Markdown may have consumed those escapes.
 */
function skillSources(name: string) {
  return [name, `"${name}"`, serializeComposerSkillToken(name).slice(1)];
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
  const source = /^\p{Sc}(.+)$/su.exec(url)?.[1];
  return source === undefined
    ? undefined
    : skills?.find((skill) => skillSources(skill.name).includes(source));
}
