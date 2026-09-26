import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";

import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export type InlineSkill = Pick<
  ServerProviderSkill,
  "name" | "displayName" | "description" | "shortDescription"
>;

export function SkillInlineText(props: { text: string; skills: ReadonlyArray<InlineSkill> }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of props.text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = props.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }

    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(<SkillChip key={`${start}:${name}`} skill={skill} rawText={rawText} />);
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills),
    );
  });
}

function resolveInlineSkillDescription(skill: InlineSkill): string | null {
  const shortDescription = skill.shortDescription?.trim();
  if (shortDescription) {
    return shortDescription;
  }
  const description = skill.description?.trim();
  return description || null;
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  const description = resolveInlineSkillDescription(props.skill);
  const chip = (
    <ContextChip
      kind="skill"
      data-markdown-copy={props.rawText}
      tabIndex={description ? 0 : undefined}
    >
      <SkillChipIcon />
      <ContextChipLabel>{formatProviderSkillDisplayName(props.skill)}</ContextChipLabel>
    </ContextChip>
  );

  if (!description) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The skill glyph. The package icon fills its viewBox edge-to-edge, unlike the
 * file-type icons that carry intrinsic padding, so it renders one step smaller
 * and lighter than the chip's default svg size to match the file chips' optical weight.
 */
export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="block size-[1em] shrink-0 self-center opacity-85"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
