import { definePluginComponent } from "~/plugins/features";
import { collectComposerModelMentions } from "@t3tools/client-runtime/composer-model-mentions";
import type { EnvironmentId, ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { T, useGT } from "gt-react";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { PopoverClose } from "../ui/popover";
import { ModelMentionChip } from "./ModelMentionChip";

const SkillInlineText = definePluginComponent(
  "component:components/chat/SkillInlineText/SkillInlineText",
  PluginOriginalSkillInlineText,
);

function PluginOriginalSkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
  environmentId: EnvironmentId | null;
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

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<ServerProviderSkill>,
  threadRef: ScopedThreadRef | undefined,
  environmentId: EnvironmentId | null,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return (
        <SkillInlineText
          text={child}
          skills={skills}
          threadRef={threadRef}
          environmentId={environmentId}
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
      renderSkillInlineMarkdownChildren(child.props.children, skills, threadRef, environmentId),
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

export const SkillChipPopover = definePluginComponent(
  "component:components/chat/SkillInlineText/SkillChipPopover",
  PluginOriginalSkillChipPopover,
);

function PluginOriginalSkillChipPopover(props: {
  label: string;
  description: string | null | undefined;
  copyMarkdown?: string | undefined;
  onViewInstructions: (() => void) | undefined;
}) {
  const gt = useGT();
  return (
    <ContextChipPopover
      kind="skill"
      icon={<SkillChipIcon />}
      label={props.label}
      accessibleLabel={gt("Skill {label}", { label: props.label })}
      copyMarkdown={props.copyMarkdown}
    >
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{props.description || gt("No description is available for this skill.")}</p>
        {props.onViewInstructions ? (
          <PopoverClose
            render={<Button variant="outline" size="sm" />}
            onClick={props.onViewInstructions}
          >
            <T>View instructions</T>
          </PopoverClose>
        ) : null}
      </div>
    </ContextChipPopover>
  );
}

export const SkillChipIcon = definePluginComponent(
  "component:components/chat/SkillInlineText/SkillChipIcon",
  PluginOriginalSkillChipIcon,
);

function PluginOriginalSkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
