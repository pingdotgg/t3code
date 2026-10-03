import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  readComposerDraftSelection: () => null,
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("mobile multi-word path search", () => {
  let root: Root;
  let menu: ReturnType<typeof useComposerCommandMenu>;
  function Probe({ draftMessage, ownerKey }: { draftMessage: string; ownerKey: string }) {
    const state = useComposerCommandMenu({
      draftMessage,
      ownerKey,
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: false,
      hasCompactableConversation: false,
      onChangeDraftMessage() {},
    });
    useLayoutEffect(() => {
      menu = state;
    });
    return null;
  }
  async function type(text: string, ownerKey = "draft-1") {
    await act(() => root.render(createElement(Probe, { draftMessage: text, ownerKey })));
    await act(() => menu.onSelectionChange({ start: text.length, end: text.length }));
  }
  beforeEach(() => {
    const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  it("keeps the full query through spaces and closes after accepting a file", async () => {
    const query = "Foreign Subsidiaries Motion Video";
    for (let length = 0; length <= query.length; length += 1) {
      await type("@" + query.slice(0, length));
      expect(menu.trigger).toEqual({
        kind: "path",
        query: query.slice(0, length),
        rangeStart: 0,
        rangeEnd: length + 1,
      });
    }
    await type("[Foreign Subsidiaries](Foreign%20Subsidiaries) ");
    expect(menu.trigger).toBeNull();
  });
  it("keeps typed extensions separate from existing prose and closes on a caret jump", async () => {
    const suffix = " then summarize";
    await type("@Foreign" + suffix);
    await act(() => menu.onSelectionChange({ start: 8, end: 8 }));
    await act(() =>
      root.render(
        createElement(Probe, {
          draftMessage: "@Foreign Subsidiaries" + suffix,
          ownerKey: "draft-1",
        }),
      ),
    );
    const cursor = "@Foreign Subsidiaries".length;
    await act(() => menu.onSelectionChange({ start: cursor, end: cursor }));
    expect(menu.trigger?.query).toBe("Foreign Subsidiaries");
    expect(menu.trigger?.rangeEnd).toBe(cursor);
    const end = cursor + suffix.length;
    await act(() => menu.onSelectionChange({ start: end, end }));
    expect(menu.trigger).toBeNull();
  });

  it("does not carry an active search into a different draft", async () => {
    await type("@Foreign");
    await type("@Foreign Subsidiaries");
    expect(menu.trigger?.query).toBe("Foreign Subsidiaries");
    await type("@Foreign Subsidiaries", "draft-2");
    expect(menu.trigger).toBeNull();
  });
  it("closes when text is selected and does not resume it after the boundary", async () => {
    await type("@Foreign ");
    await act(() => menu.onSelectionChange({ start: 0, end: 9 }));
    expect(menu.trigger).toBeNull();
    await type("@Foreign Subsidiaries");
    expect(menu.trigger).toBeNull();
  });
});
