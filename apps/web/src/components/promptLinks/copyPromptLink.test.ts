import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { composerPromptLink, promptLinkFor } from "./copyPromptLink";

it.each([false, true])("exports tray quotes and comments with context=%s", (withContext) => {
  const target = scopeThreadRef(EnvironmentId.make("link-test"), ThreadId.make("tray"));
  const citation = {
    version: 1 as const,
    environmentId: target.environmentId,
    threadId: target.threadId,
    messageId: MessageId.make("source"),
    text: "quote",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
    comment: "Keep this",
  };
  const store = useComposerDraftStore.getState();
  store.setTrayCitations(target, [citation]);
  for (const prompt of ["", "Reply"]) {
    store.setPrompt(target, prompt);
    expect(
      composerPromptLink({
        target,
        project: undefined,
        providers: [],
        threadModelSelection: null,
        withContext,
      }),
    ).toBe(
      promptLinkFor(
        [serializeAssistantCitation(citation), prompt].filter(Boolean).join("\n"),
        withContext ? { repository: null, provider: null, model: null } : undefined,
      ),
    );
  }
  store.clearComposerContent(target);
});
