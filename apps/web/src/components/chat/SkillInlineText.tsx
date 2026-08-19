import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName" | "path">;

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
  threadRef?: ScopedThreadRef | undefined;
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
        threadRef={props.threadRef}
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
  threadRef?: ScopedThreadRef | undefined,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} threadRef={threadRef} />;
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
      renderSkillInlineMarkdownChildren(child.props.children, skills, threadRef),
    );
  });
}

function SkillChip(props: {
  skill: InlineSkill;
  rawText: string;
  threadRef?: ScopedThreadRef | undefined;
}) {
  const threadRef = props.threadRef;
  const chipContents = (
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
  const className = cn(
    CHAT_INLINE_CHIP_CLASS_NAME,
    "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
  );

  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.rawText}>
      {threadRef ? (
        <button
          type="button"
          className={cn(
            className,
            "cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:hover:brightness-110",
          )}
          aria-label={`Open ${formatProviderSkillDisplayName(props.skill)} skill`}
          onClick={() => {
            useRightPanelStore.getState().openFile(threadRef, props.skill.path);
          }}
        >
          {chipContents}
        </button>
      ) : (
        <span className={className}>{chipContents}</span>
      )}
    </span>
  );
}
