import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { normalizeSharedLocationMessage } from "@t3tools/shared/sharedLocation";

/** Project a user message's structured and legacy location context for a provider. */
export function projectUserMessageForProvider(input: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): string {
  const normalized = normalizeSharedLocationMessage({
    text: input.text,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  return projectComposerContextForProvider({
    text: normalized.text,
    records: normalized.context?.records ?? [],
  });
}
