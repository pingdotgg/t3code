import { useAtomValue } from "@effect/atom-react";
import { useResolveClassNames } from "uniwind";

import { environmentThreadShells } from "../../state/threads";
import { createChatsStatusAtom } from "./chats-status";

const chatsStatusAtom = createChatsStatusAtom(environmentThreadShells.navigationThreadShellsAtom);

const PRESENTATION = {
  approval: { label: "Pending approval", color: "bg-warning-foreground" },
  input: { label: "Awaiting input", color: "bg-adaptive-indigo-600-300" },
  request: { label: "Guest request", color: "bg-adaptive-fuchsia-600-300" },
  failed: { label: "Failed", color: "bg-danger-foreground" },
  done: { label: "Done", color: "bg-adaptive-emerald-700-300" },
} as const;

export function useChatsStatus(chatsSelected: boolean) {
  const status = useAtomValue(chatsStatusAtom);
  const presentation = status === null || chatsSelected ? null : PRESENTATION[status];
  const style = useResolveClassNames(presentation?.color ?? "");
  return {
    color:
      presentation !== null && typeof style.backgroundColor === "string"
        ? style.backgroundColor
        : null,
    label: presentation === null ? "Chats" : `Chats, ${presentation.label}`,
  };
}
