import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
  revealSideChatCitation,
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

function createCitationRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("assistant citation navigation", () => {
  it("preserves encoded quote whitespace through router navigation and reload", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation, null));

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
  });

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation, null));
    const previous = router.state.location;
    await router.navigate(assistantCitationNavigation(citation, null));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
  });

  it("opens a side chat citation as a tab of its parent thread", async () => {
    resetRightPanels();
    const router = createCitationRouter("/environment-one/thread-parent");
    await router.navigate(assistantCitationNavigation(sideChatCitation, sideChatShell));
    expect(router.state.location.pathname).toBe("/environment-one/thread-parent");
    await revealAtRoute(router);

    expectSideChatRevealedOnParent(router);
  });

  it("opens the side chat tab when arriving on the parent with its citation", async () => {
    resetRightPanels();
    const linked = createCitationRouter("/environment-one/thread-parent");
    await linked.navigate(assistantCitationNavigation(sideChatCitation, sideChatShell));
    const router = createCitationRouter(linked.history.location.href);
    await router.load();
    await revealAtRoute(router);

    expectSideChatRevealedOnParent(router);
  });

  it("moves a citation activated before its side chat shell loaded onto the parent", async () => {
    resetRightPanels();
    const router = createCitationRouter("/environment-one/thread-parent");
    await router.navigate(assistantCitationNavigation(sideChatCitation, null));
    const activation = router.state.location.state.assistantCitationActivation;
    expect(router.state.location.pathname).toBe("/environment-one/side-chat-one");

    await revealAtRoute(router);

    expectSideChatRevealedOnParent(router);
    expect(router.state.location.state.assistantCitationActivation).toBe(activation);
    expect(router.history.length).toBe(2);
  });

  it("keeps quotes from forks on their own thread", () => {
    const forkShell = { lineage: { ...sideChatShell.lineage, sideChat: false } };

    expect(assistantCitationNavigation(sideChatCitation, forkShell).params.threadId).toBe(
      sideChatCitation.threadId,
    );
  });

  it("leaves an unrelated route alone", async () => {
    resetRightPanels();
    const router = createCitationRouter("/environment-one/thread-other");
    await router.navigate({
      ...assistantCitationNavigation(sideChatCitation, null),
      params: { environmentId: citation.environmentId, threadId: ThreadId.make("thread-other") },
    });
    await revealAtRoute(router);

    expect(router.state.location.pathname).toBe("/environment-one/thread-other");
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("ignores a reveal for a side chat the location no longer quotes", async () => {
    resetRightPanels();
    const router = createCitationRouter("/environment-one/thread-parent");
    await router.navigate(assistantCitationNavigation(sideChatCitation, sideChatShell));
    await revealAtRoute(router, ThreadId.make("side-chat-two"));

    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});

const parentThreadId = ThreadId.make("thread-parent");
const sideChatCitation = { ...citation, threadId: ThreadId.make("side-chat-one") };
const sideChatShell = {
  lineage: {
    parentThreadId,
    relationshipToParent: "fork" as const,
    rootThreadId: parentThreadId,
    sideChat: true,
  },
};

function resetRightPanels() {
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
}

/** What the route-level ChatView does once the side chat shell is known. */
function revealAtRoute(
  router: ReturnType<typeof createCitationRouter>,
  sideChatThreadId = sideChatCitation.threadId,
) {
  const { pathname, state } = router.state.location;
  return revealSideChatCitation(
    router,
    scopeThreadRef(citation.environmentId, ThreadId.make(pathname.split("/").at(-1) ?? "")),
    sideChatThreadId,
    parentThreadId,
    state.assistantCitationActivation ?? state.__TSR_key ?? "",
  );
}

function expectSideChatRevealedOnParent(router: ReturnType<typeof createCitationRouter>) {
  expect(router.state.location.pathname).toBe("/environment-one/thread-parent");
  expect(assistantCitationFromLocation(router.state.location.href)).toEqual(sideChatCitation);
  expect(
    selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      scopeThreadRef(citation.environmentId, parentThreadId),
    ),
  ).toMatchObject({ kind: "side-chat", threadId: sideChatCitation.threadId });
}
