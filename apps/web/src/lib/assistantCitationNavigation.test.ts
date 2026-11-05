import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import {
  MAX_CITATION_HREF_LENGTH,
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "./assistantCitationNavigation";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "first line\n\tsecond line (with a #hash & spaces) 🚀",
  start: 12,
  end: 59,
  prefix: "Before:\n",
  suffix: "\nAfter.",
};

const largeCitation = {
  ...citation,
  text: "引".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH),
  comment: "注".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH),
  start: 0,
  end: ASSISTANT_CITATION_MAX_TEXT_LENGTH,
};
const maximumCitation = {
  ...largeCitation,
  messageId: MessageId.make(
    largeCitation.messageId +
      "m".repeat(MAX_CITATION_HREF_LENGTH - formatAssistantCitationHref(largeCitation).length),
  ),
};

function createCitationRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("assistant citation navigation", () => {
  it.each([citation, maximumCitation])(
    "preserves encoded quotes through router navigation and reload (%#)",
    async (citation) => {
      expect(parseAssistantCitationHref(formatAssistantCitationHref(citation))).toEqual(citation);
      const router = createCitationRouter();
      await router.navigate(assistantCitationNavigation(citation));

      expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
      let href = router.history.location.href;
      for (let reload = 0; reload < 3; reload++) {
        const reloaded = createCitationRouter(href);
        await reloaded.load();
        await reloaded.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: citation.environmentId, threadId: citation.threadId },
          hash: true,
          replace: true,
        });
        href = reloaded.history.location.href;
        expect(assistantCitationFromLocation(href)).toEqual(citation);
      }
    },
  );

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation));
    const previous = router.state.location;
    await router.navigate(assistantCitationNavigation(citation));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
  });
});
