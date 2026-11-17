import { UsersIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "../ContextChip";

/** `@handle` naming a member of the thread's group, in place of a file chip. */
export function GroupMemberChip(props: {
  label: string;
  isPrimary: boolean;
  source?: string;
  onOpenWork?: (() => void) | undefined;
}) {
  return (
    <ContextChip
      kind="model"
      aria-label={`${props.isPrimary ? "Primary" : "Group member"} ${props.label}`}
      contentEditable={false}
      render={props.onOpenWork ? <button type="button" onClick={props.onOpenWork} /> : undefined}
      {...(props.source === undefined ? {} : { "data-markdown-copy": props.source })}
    >
      <UsersIcon aria-hidden />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}
