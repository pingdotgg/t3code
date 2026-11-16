import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../../components/ui/toast";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import {
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import {
  citeInThread,
  citeOpensReplies,
  registerReplyBox,
  sheetInitialFocus,
} from "./subThreadCite";
import { openSubThread, useSubThreadsStore } from "./subThreadsState";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const threadKey = scopedThreadKey(threadRef);
const citation: AssistantCitation = {
  version: 1,
  ...threadRef,
  messageId: MessageId.make("first-b"),
  text: "Pick A",
  start: 0,
  end: 6,
  prefix: "",
  suffix: " or B",
};
const opaqueSourceAnchor = {} as AssistantCitationSourceAnchor;

function fakeBox(text: string, answer = true) {
  const cite = vi.fn(() => answer);
  const ref = {
    current: {
      readSnapshot: () => ({ value: text, cursor: 0, expandedCursor: 0, contextIds: [] }),
      citeAssistantText: cite,
    },
  };
  return { ref, cite };
}
type FakeBox = ReturnType<typeof fakeBox>;

function mainView(ownText = "", layout: "inline" | "sheet" = "inline") {
  const matchMedia = vi.fn(() => ({ matches: layout === "sheet" }));
  vi.stubGlobal("window", { matchMedia });
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  useSubThreadsStore.setState({ shownByThreadKey: {} });
  const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  const own = fakeBox(ownText);
  return {
    toast,
    ownCite: own.cite,
    cite: () => citeInThread(threadRef, "first-b", own.ref, citation, opaqueSourceAnchor),
    [Symbol.dispose]: () => {
      toast.mockRestore();
      vi.unstubAllGlobals();
      sheetInitialFocus();
    },
  };
}

const mounted = (first: string, box: FakeBox): Disposable => ({
  [Symbol.dispose]: registerReplyBox(threadKey, first, box.ref),
});

function mountsWhenShown(first: string, box: FakeBox): Disposable {
  let unmount: (() => void) | null = null;
  const stop = useSubThreadsStore.subscribe((state) => {
    if (unmount === null && state.shownByThreadKey[threadKey] === first) {
      unmount = registerReplyBox(threadKey, first, box.ref);
    }
  });
  return {
    [Symbol.dispose]: () => {
      stop();
      unmount?.();
    },
  };
}

const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const repliesOnScreen = () =>
  selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "replies";
const shownSubThread = () => useSubThreadsStore.getState().shownByThreadKey[threadKey];

describe("a Cite in the main list of a Chat + Replies thread", () => {
  it.each([
    { replies: undefined, opens: false },
    { replies: 0, opens: false },
    { replies: 1, opens: true },
  ])("opens the message's Replies only when it has some: $replies", ({ replies, opens }) => {
    const summary =
      replies === undefined
        ? undefined
        : {
            first: "first-b",
            firstFrom: "agent" as const,
            firstText: "Pick A or B",
            replies,
            lastAt: "2026-11-16T00:00:00.000Z",
            lastFrom: "agent" as const,
            lastText: "Pick A or B",
            agentReplyTimes: [],
          };
    expect(citeOpensReplies(summary)).toBe(opens);
  });

  it("goes into the main box when it has text", () => {
    using view = mainView(" my note ");
    const reply = fakeBox("a reply draft");
    using _reply = mounted("first-a", reply);
    openSubThread(threadRef, "first-a");

    expect(view.cite()).toBe(true);
    expect(view.ownCite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
    expect(reply.cite).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "goes into the shown reply box with text, and returns its answer %s",
    (answer) => {
      using view = mainView();
      const reply = fakeBox("a reply draft", answer);
      using _reply = mounted("first-a", reply);
      openSubThread(threadRef, "first-a");

      expect(view.cite()).toBe(answer);
      expect(reply.cite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
      expect(view.ownCite).not.toHaveBeenCalled();
      expect(shownSubThread()).toBe("first-a");
      expect(view.toast).toHaveBeenCalledTimes(answer ? 0 : 1);
    },
  );

  it.each([
    { start: "the panel is closed and was left maximized", shown: null },
    { start: "Replies shows another sub-thread with an empty box", shown: "first-a" },
    { start: "the cited box is mounted while the panel is closed", shown: "first-b" },
  ])("opens the cited sub-thread and goes into its box when $start", ({ shown }) => {
    using view = mainView();
    const store = useRightPanelStore.getState();
    const other = fakeBox("");
    const cited = fakeBox("");
    using _other = shown === "first-a" ? mounted("first-a", other) : null;
    using _cited =
      shown === "first-b" ? mounted("first-b", cited) : mountsWhenShown("first-b", cited);
    if (shown === null) store.setMaximized(threadRef, true);
    else openSubThread(threadRef, shown);
    if (shown === "first-b") store.close(threadRef);
    const revision = store.getUserActionRevision(threadRef);

    expect(view.cite()).toBe(true);
    expect(cited.cite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
    expect(other.cite).not.toHaveBeenCalled();
    expect(view.ownCite).not.toHaveBeenCalled();
    expect(shownSubThread()).toBe("first-b");
    expect(repliesOnScreen()).toBe(true);
    expect(panel().maximized).toBeUndefined();
    expect(store.getUserActionRevision(threadRef)).toBe(revision + 1);
  });

  it("returns the cited box's refusal after opening it", () => {
    using view = mainView();
    const cited = fakeBox("", false);
    using _cited = mountsWhenShown("first-b", cited);

    expect(view.cite()).toBe(false);
    expect(cited.cite).toHaveBeenCalledOnce();
    expect(view.toast).toHaveBeenCalledOnce();
  });

  it("keeps the selection when no reply box mounts after the open", () => {
    using view = mainView();

    expect(view.cite()).toBe(false);
    expect(view.toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Could not open the reply box" }),
    );
    expect(view.ownCite).not.toHaveBeenCalled();
  });

  it("does not count a mounted reply box as shown while the panel is closed", () => {
    using view = mainView();
    const hidden = fakeBox("a reply draft");
    using _hidden = mounted("first-a", hidden);
    openSubThread(threadRef, "first-a");
    useRightPanelStore.getState().close(threadRef);
    const cited = fakeBox("");
    using _cited = mountsWhenShown("first-b", cited);

    expect(view.cite()).toBe(true);
    expect(hidden.cite).not.toHaveBeenCalled();
    expect(cited.cite).toHaveBeenCalledOnce();
  });

  it("treats a box that shows only whitespace as empty", () => {
    using view = mainView(" \n\t");
    const blank = fakeBox(" \n");
    using _blank = mounted("first-a", blank);
    openSubThread(threadRef, "first-a");
    const cited = fakeBox("");
    using _cited = mountsWhenShown("first-b", cited);

    expect(view.cite()).toBe(true);
    expect(view.ownCite).not.toHaveBeenCalled();
    expect(blank.cite).not.toHaveBeenCalled();
    expect(cited.cite).toHaveBeenCalledOnce();
    expect(shownSubThread()).toBe("first-b");
  });

  it.each([
    { layout: "sheet", answer: true, sheetFocuses: false },
    { layout: "sheet", answer: false, sheetFocuses: true },
    { layout: "inline", answer: true, sheetFocuses: true },
  ] as const)(
    "leaves focus to the comment box when it opens the sheet: $layout, box answers $answer",
    ({ layout, answer, sheetFocuses }) => {
      using view = mainView("", layout);
      using _cited = mountsWhenShown("first-b", fakeBox("", answer));

      expect(view.cite()).toBe(answer);
      expect(sheetInitialFocus()).toBe(sheetFocuses);
      expect(sheetInitialFocus()).toBe(true);
    },
  );
});
