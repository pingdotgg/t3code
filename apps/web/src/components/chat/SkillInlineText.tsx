import { collectComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import {
  groupMentionOccurrences,
  type ThreadGroup,
} from "@t3tools/client-runtime/state/thread-group";
import type { EnvironmentId, ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { GroupMemberChip } from "./GroupMemberChip";
import { PopoverClose } from "../ui/popover";
import { ModelMentionChip } from "./ModelMentionChip";

function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
  environmentId: EnvironmentId | null;
  group: ThreadGroup | null;
}) {
  const chips: Array<{ start: number; end: number; node: ReactNode }> = [];
  for (const { start, end, skill, rawText } of matchInlineSkills(props.text, props.skills)) {
    chips.push({
      start,
      end,
      node: (
        <SkillChipPopover
          key={`${start}:${skill.name}`}
          label={formatProviderSkillDisplayName(skill)}
          description={skillPopoverDescription(skill)}
          copyMarkdown={rawText}
          onViewInstructions={skillInstructionsOpener(props.threadRef, skill)}
        />
      ),
    });
  }
  for (const mention of groupMentionOccurrences(props.text, props.group)) {
    const member = mention.member;
    const threadRef = props.threadRef;
    chips.push({
      start: mention.start,
      end: mention.end,
      node: (
        <GroupMemberChip
          key={`${mention.start}:group`}
          label={mention.label}
          isPrimary={mention.isPrimary}
          source={mention.source}
          onOpenWork={
            member === "primary" || threadRef === undefined
              ? undefined
              : () => useRightPanelStore.getState().openSideChat(threadRef, member)
          }
        />
      ),
    });
  }
  for (const mention of collectComposerModelMentions(props.text)) {
    chips.push({
      start: mention.start,
      end: mention.end,
      node: (
        <ModelMentionChip
          key={`${mention.start}:model`}
          environmentId={props.environmentId}
          instanceId={mention.instanceId}
          model={mention.model}
          source={mention.source}
        />
      ),
    });
  }
  if (chips.length === 0) {
    return <>{props.text}</>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const chip of chips.toSorted((left, right) => left.start - right.start)) {
    if (chip.start < cursor) continue;
    if (chip.start > cursor) {
      nodes.push(props.text.slice(cursor, chip.start));
    }
    nodes.push(chip.node);
    cursor = chip.end;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderInlineChipMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<ServerProviderSkill>,
  threadRef: ScopedThreadRef | undefined,
  environmentId: EnvironmentId | null,
  group: ThreadGroup | null,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return (
        <SkillInlineText
          text={child}
          skills={skills}
          threadRef={threadRef}
          environmentId={environmentId}
          group={group}
        />
      );
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom markdown components replace intrinsic types; check their hast tags.
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
      renderInlineChipMarkdownChildren(
        child.props.children,
        skills,
        threadRef,
        environmentId,
        // Routing reads the raw prompt, where `**@astra**` has `*` before the `@` and names nobody.
        null,
      ),
    );
  });
}

export function skillPopoverDescription(
  skill: Pick<ServerProviderSkill, "description" | "shortDescription">,
) {
  return skill.description?.trim() || skill.shortDescription?.trim() || null;
}

export function skillInstructionsOpener(
  threadRef: ScopedThreadRef | null | undefined,
  skill: Pick<ServerProviderSkill, "path"> | undefined,
) {
  if (!threadRef || !skill?.path) return undefined;
  return () => useRightPanelStore.getState().openFile(threadRef, skill.path);
}

export function SkillChipPopover(props: {
  label: string;
  description: string | null | undefined;
  copyMarkdown?: string | undefined;
  onViewInstructions: (() => void) | undefined;
}) {
  return (
    <ContextChipPopover
      kind="skill"
      icon={<SkillChipIcon />}
      label={props.label}
      accessibleLabel={`Skill ${props.label}`}
      copyMarkdown={props.copyMarkdown}
    >
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{props.description || "No description is available for this skill."}</p>
        {props.onViewInstructions ? (
          <PopoverClose
            render={<Button variant="outline" size="sm" />}
            onClick={props.onViewInstructions}
          >
            View instructions
          </PopoverClose>
        ) : null}
      </div>
    </ContextChipPopover>
  );
}

export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
