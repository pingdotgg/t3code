import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";

import { composerPromptLink } from "./copyPromptLink";

describe("composerPromptLink", () => {
  it("shares a draft's context chips as their labels, as a sent message's link does", () => {
    const target = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    const image = formatComposerContextReference({
      kind: "image",
      contextId: "image_abc" as ComposerContextId,
      label: "screenshot.png",
    });
    useComposerDraftStore.getState().setPrompt(target, `Why does ${image} look wrong?`);

    const link = composerPromptLink({
      target,
      project: undefined,
      providers: [],
      threadModelSelection: null,
      threadStarted: false,
      withContext: false,
    });

    expect(link).not.toBeNull();
    const parsed = parseNewThreadLink(new URL(link!).search);
    expect(parsed).toMatchObject({
      ok: true,
      value: { prompt: { text: "Why does screenshot.png look wrong?" } },
    });
  });
});
