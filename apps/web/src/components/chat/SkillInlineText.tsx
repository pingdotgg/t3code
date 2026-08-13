import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  onSkillClick?: ((skill: InlineSkill) => void) | undefined;
}) {
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
    nodes.push(
      <SkillChip
        key={`${start}:${name}`}
        skill={skill}
        rawText={rawText}
        onClick={props.onSkillClick}
      />,
    );
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
  onSkillClick?: (skill: InlineSkill) => void,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} onSkillClick={onSkillClick} />;
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
      renderSkillInlineMarkdownChildren(child.props.children, skills, onSkillClick),
    );
  });
}

function SkillChip(props: {
  skill: InlineSkill;
  rawText: string;
  onClick?: ((skill: InlineSkill) => void) | undefined;
}) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
      />
      <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>
        {formatProviderSkillDisplayName(props.skill)}
      </span>
    </>
  );
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.rawText}>
      {props.onClick ? (
        <button
          type="button"
          className={cn(
            CHAT_INLINE_CHIP_CLASS_NAME,
            "cursor-pointer border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 hover:bg-fuchsia-500/20 dark:text-fuchsia-300",
          )}
          aria-label={`Open $${props.skill.name}`}
          onClick={() => props.onClick?.(props.skill)}
        >
          {content}
        </button>
      ) : (
        <span
          className={cn(
            CHAT_INLINE_CHIP_CLASS_NAME,
            "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
