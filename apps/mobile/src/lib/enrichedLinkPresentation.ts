import type { ComposerContextRecord } from "@t3tools/contracts";
import { contextChipPresentation } from "./composerChipPresentation";
import type { MarkdownFileIcon } from "./markdownLinks";
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

/** Context identity comes from the URL, even when different chips share a label. */
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

/** Conservative recognition for Enriched's whole-span inline-code link hook. */
export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

export function enrichedSkillLinkRegex(skills?: ReadonlyArray<SelectableMarkdownSkill>) {
  const names = [...new Set(skills?.map((skill) => skill.name) ?? [])].filter(Boolean);
  if (names.length === 0) return null;
  names.sort((a, b) => b.length - a.length);
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9_$-])\\$(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`);
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
