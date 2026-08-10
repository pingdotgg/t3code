import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";

export function composerCommandEmptyText(
  triggerKind: ComposerTriggerKind | null,
  isLoading: boolean,
): string {
  if (isLoading) {
    return triggerKind === "path" ? "Searching files…" : "Loading…";
  }

  switch (triggerKind) {
    case "path":
      return "No matching files or folders.";
    case "skill":
      return "No skills found.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}
