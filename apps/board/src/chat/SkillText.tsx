import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode, useContext } from "react";

import { SkillChip } from "./SkillChip";
import { SkillsContext } from "./skills";

/** A string with each `$skill` it names drawn as a chip. */
export function SkillText({ text }: { text: string }) {
  const skills = useContext(SkillsContext);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, skill } of matchInlineSkills(text, skills)) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<SkillChip key={`${start}:${skill.name}`} skill={skill} />);
    cursor = end;
  }
  if (parts.length === 0) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

interface Passed {
  readonly children?: ReactNode;
  readonly node?: { readonly tagName?: string };
}

/** The children of a rendered paragraph or list item, with chips in their text but not in code or links. */
export function withSkillChips(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (child === null) return child;
    if (!isValidElement<Passed>(child)) return <SkillText text={String(child)} />;
    // A custom markdown component replaces the intrinsic type, so the hast node names the tag.
    const tag = child.props.node?.tagName ?? child.type;
    if (tag === "code" || tag === "a" || !("children" in child.props)) return child;
    return cloneElement(child, undefined, withSkillChips(child.props.children));
  });
}
