import type { ComposerCommandItem } from "./ComposerCommandMenu";

export type ComposerMenuKeyAction =
  | { kind: "highlight"; direction: "ArrowDown" | "ArrowUp" }
  | { kind: "select" }
  | { kind: "pin-mode" };

export function resolveComposerMenuKeyAction(params: {
  key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab";
  altKey: boolean;
  itemCount: number;
  activeItemType: ComposerCommandItem["type"] | null;
}): ComposerMenuKeyAction | null {
  if ((params.key === "ArrowDown" || params.key === "ArrowUp") && params.itemCount > 0) {
    return { kind: "highlight", direction: params.key };
  }

  if (params.key === "Enter" && params.altKey && params.activeItemType === "skill") {
    return { kind: "pin-mode" };
  }

  // Alt+Enter on any other row still selects, because only a skill row has
  // something to pin.
  if ((params.key === "Enter" || params.key === "Tab") && params.activeItemType !== null) {
    return { kind: "select" };
  }

  return null;
}
