import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type * as Path from "effect/Path";

/**
 * A user message as the provider reads it. Mentions are saved relative to the
 * checkout; an agent in a subdirectory of it would otherwise read them against
 * its own cwd.
 */
export function providerMessageText(input: {
  readonly path: Path.Path;
  readonly message: Pick<OrchestrationV2ConversationMessage, "text" | "context">;
  readonly checkoutRoot: string | null;
  readonly agentCwd: string | null;
}): string {
  const { path, checkoutRoot, agentCwd } = input;
  const mentionRoot =
    checkoutRoot !== null &&
    agentCwd !== null &&
    path.resolve(checkoutRoot) !== path.resolve(agentCwd)
      ? checkoutRoot
      : null;
  return projectComposerContextForProvider({
    text: input.message.text,
    records: (input.message.context?.records ?? []).map((record) =>
      mentionRoot !== null &&
      record.kind === "mention" &&
      "path" in record &&
      !path.isAbsolute(record.path) &&
      !/^~(?:[\\/]|$)/.test(record.path)
        ? { ...record, path: path.join(mentionRoot, record.path) }
        : record,
    ),
  });
}
