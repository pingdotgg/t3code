import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { hasInlineSkillToken } from "@t3tools/shared/skillInlineTokens";

interface ThreadProviderSkillFeedEntry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly text: string;
  };
}

export function shouldLoadThreadProviderWorkspaceSkills(input: {
  readonly composerSkillMenuActive: boolean;
  readonly draftMessage: string;
  readonly feed: ReadonlyArray<ThreadProviderSkillFeedEntry>;
}): boolean {
  if (input.composerSkillMenuActive) {
    return true;
  }

  if (collectComposerInlineTokens(input.draftMessage).some((token) => token.type === "skill")) {
    return true;
  }

  return input.feed.some(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      hasInlineSkillToken(entry.message.text),
  );
}
