import type { ComposerContextRecord, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  composerChipSizeSuffix,
  contextChipIcon,
  contextChipPresentation,
  contextRecordFileName,
  type ContextChipIconRef,
  UNAVAILABLE_CONTEXT_CHIP_PRESENTATION,
} from "./composerChipPresentation";
import { formatComposerModelMention } from "@t3tools/client-runtime/composerModelMentions";
import type {
  SelectableMarkdownModel,
  SelectableMarkdownSkill,
} from "../native/SelectableMarkdownText.types";
import {
  formatComposerContextHref,
  parseComposerContextHref,
} from "@t3tools/shared/composerContextReferences";
import { hasThreadLinks, parseThreadLinkHref } from "@t3tools/shared/threadLinks";

export function enrichedContextLinkPresentation(
  href: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): { accent?: string; icon: ContextChipIconRef; label?: string } | undefined {
  const reference = parseComposerContextHref(href);
  if (!reference) return undefined;
  const record = records?.find((candidate) => candidate.contextId === reference.contextId);
  const presentation =
    records && !record
      ? UNAVAILABLE_CONTEXT_CHIP_PRESENTATION
      : contextChipPresentation(reference.kind, record);
  const size = composerChipSizeSuffix(record);
  return {
    ...(presentation.accent ? { accent: presentation.accent } : {}),
    icon: contextChipIcon(presentation, contextRecordFileName(record)),
    ...(record && size ? { label: `${record.label} · ${size}` } : {}),
  };
}

export function enrichedThreadLinkPresentation(
  href: string,
): { accent?: string; icon: ContextChipIconRef } | undefined {
  if (!parseThreadLinkHref(href)) return undefined;
  const presentation = contextChipPresentation("thread");
  return {
    ...(presentation.accent ? { accent: presentation.accent } : {}),
    icon: contextChipIcon(presentation, ""),
  };
}

export interface ThreadChipTarget {
  readonly href: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly link: boolean;
}

export function threadChipTargets(
  environmentId: EnvironmentId,
  markdown: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): ReadonlyArray<ThreadChipTarget> {
  const targets = new Map<string, ThreadChipTarget>();
  if (hasThreadLinks(markdown)) {
    for (const [, href = ""] of markdown.matchAll(/\]\((t3-thread:\/\/v[12]\/[^\s)]+)\)/g)) {
      const link = parseThreadLinkHref(href);
      if (link) {
        targets.set(href, {
          href,
          environmentId: link.environmentId ?? environmentId,
          threadId: link.threadId,
          link: true,
        });
      }
    }
  }
  for (const record of records ?? []) {
    if (record.kind !== "thread" || !("threadId" in record)) continue;
    const href = formatComposerContextHref("thread", record.contextId);
    targets.set(href, {
      href,
      environmentId: record.environmentId,
      threadId: record.threadId,
      link: false,
    });
  }
  return [...targets.values()];
}

export function enrichedLinkVariantPattern(url: string) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export const ENRICHED_INLINE_FILE_LINK_REGEX =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|lib64|srv|dev|proc|sys|run|boot|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?)$/;

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

export function enrichedSkillInstructionsPath(skill: SelectableMarkdownSkill) {
  return skill.path && !/^[a-z][a-z\d+.-]*:\/\//i.test(skill.path) ? skill.path : undefined;
}

export function buildEnrichedModelReferences(
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly iconUrl?: string | undefined;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly subProvider?: string | undefined;
    }>;
  }>,
  sources?: ReadonlySet<string>,
): ReadonlyArray<SelectableMarkdownModel> {
  return providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          !sources || sources.has(formatComposerModelMention(provider.instanceId, model.slug)),
      )
      .map((model) => {
        const qualifier = model.subProvider?.trim();
        const label = qualifier
          ? model.name
              .replace(
                new RegExp(
                  `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
                  "iu",
                ),
                "",
              )
              .trim() || model.name
          : model.name;
        return {
          source: formatComposerModelMention(provider.instanceId, model.slug),
          label,
          iconUrl: provider.iconUrl,
        };
      }),
  );
}

export function enrichedModelLinkRegex(models?: ReadonlyArray<SelectableMarkdownModel>) {
  if (!models?.length) return null;
  const alternatives = models
    .map((model) => model.source)
    .sort((a, b) => b.length - a.length)
    .map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![^\\s,(\\["'])(?:${alternatives.join("|")})(?=$|[\\s,"']|[.;:!?\\)\\]]+(?=$|[\\s,"']))`,
    "u",
  );
}

export function enrichedModelReference(
  source: string,
  models?: ReadonlyArray<SelectableMarkdownModel>,
) {
  return models?.find((model) => model.source === source);
}

export function enrichedTextLinkRegex(
  skills?: ReadonlyArray<SelectableMarkdownSkill>,
  models?: ReadonlyArray<SelectableMarkdownModel>,
) {
  const patterns = [enrichedSkillLinkRegex(skills), enrichedModelLinkRegex(models)]
    .filter((pattern) => pattern !== null)
    .map((pattern) => `(?:${pattern.source})`);
  return patterns.length ? new RegExp(patterns.join("|"), "u") : null;
}
