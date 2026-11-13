import { validateThreadTag } from "@t3tools/client-runtime/state/threadTagFilter";

export type RenameTagCheck =
  | { readonly kind: "unchanged" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly to: string; readonly merges: boolean };

/** A case-only rename is a real change; landing on another existing tag merges the two. */
export function checkTagRename(
  tag: string,
  input: string,
  existing: ReadonlyArray<string>,
): RenameTagCheck {
  const checked = validateThreadTag(input, []);
  if (checked.kind === "empty") return { kind: "error", message: "Enter a tag." };
  if (checked.kind === "error") return checked;
  if (checked.tag === tag) return { kind: "unchanged" };
  const lower = checked.tag.toLowerCase();
  const target = existing.find((other) => other !== tag && other.toLowerCase() === lower);
  return { kind: "ok", to: target ?? checked.tag, merges: target !== undefined };
}
