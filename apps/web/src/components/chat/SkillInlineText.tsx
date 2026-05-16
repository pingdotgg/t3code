import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { renderHighlightedText } from "./threadSearchHighlight";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export function collectSkillInlineTextLabels(
  text: string,
  skills: ReadonlyArray<InlineSkill>,
): string[] {
  const labels: string[] = [];
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    labels.push(formatProviderSkillDisplayName(skill));
  }
  return labels;
}

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  searchQuery?: string | undefined;
  searchActive?: boolean | undefined;
  keyPrefix?: string | undefined;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const renderText = (value: string, keySuffix: string): ReactNode => {
    if ((props.searchQuery ?? "").trim().length === 0) {
      return value;
    }
    return renderHighlightedText(
      value,
      props.searchQuery ?? "",
      `${props.keyPrefix ?? "skill-inline"}:${keySuffix}`,
      {
        active: props.searchActive ?? false,
      },
    );
  };

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
      nodes.push(renderText(props.text.slice(cursor, start), `text:${cursor}`));
    }
    nodes.push(<SkillChip key={`${start}:${name}`} skill={skill} rawText={rawText} />);
    cursor = start + rawText.length;
  }

  if (cursor === 0) {
    return <>{renderText(props.text, "text")}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(renderText(props.text.slice(cursor), `text:${cursor}`));
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
