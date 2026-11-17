import * as Schema from "effect/Schema";

export const PULL_REQUEST_VIEW_NAME_MAX_LENGTH = 80;

export const PullRequestSavedViewIdentity = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PULL_REQUEST_VIEW_NAME_MAX_LENGTH),
  ),
});

export function pullRequestViewNameError(
  name: string,
  views: ReadonlyArray<typeof PullRequestSavedViewIdentity.Type>,
  editingId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for this view.";
  if (trimmed.length > PULL_REQUEST_VIEW_NAME_MAX_LENGTH) {
    return `Use ${PULL_REQUEST_VIEW_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return views.some(
    (view) => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase(),
  )
    ? "A view with this name already exists."
    : null;
}
