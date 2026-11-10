export type ThreadTitleRenameResolution =
  | { readonly action: "rename"; readonly title: string }
  | { readonly action: "noop" }
  | { readonly action: "reject-empty" };

export function resolveThreadTitleRename(input: {
  readonly title: string;
  readonly originalTitle: string;
}): ThreadTitleRenameResolution {
  const title = input.title.trim();
  if (title.length === 0) return { action: "reject-empty" };
  if (title === input.originalTitle) return { action: "noop" };
  return { action: "rename", title };
}
