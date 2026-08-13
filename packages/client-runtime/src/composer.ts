export type ComposerConversationKind = "new" | "existing";

const CONVERSATION_PLACEHOLDERS = {
  new: "Describe the task, tag @files, use $skills or /commands",
  existing: "Ask for changes, add context, or attach images",
} as const satisfies Record<ComposerConversationKind, string>;

/** Returns the ordinary composer guidance shared by web, desktop, and mobile. */
export function conversationComposerPlaceholder(kind: ComposerConversationKind) {
  return CONVERSATION_PLACEHOLDERS[kind];
}
