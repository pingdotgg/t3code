import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

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
    cursor = start + rawText.length;
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
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (child.type === "code" || child.type === "a") {
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

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <span className="inline-flex align-middle leading-none">
      <span className="sr-only">{props.rawText}</span>
      <span aria-hidden="true" className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
          {formatProviderSkillDisplayName(props.skill)}
        </span>
      </span>
    </span>
  );
}
