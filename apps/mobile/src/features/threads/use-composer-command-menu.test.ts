import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useThreadSearch: vi.fn(() => ({
    matches: [],
    query: "",
    isPending: false,
    hasOlderRows: false,
  })),
  useComposerPathSearch: vi.fn(() => ({ entries: [], isPending: false, truncated: false })),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
  useComposerDraftSelection: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import type { ModelOption } from "../../lib/modelOptions";
import { useComposerPathSearch, useThreadSearch } from "../../state/queries";
import {
  buildComposerModelItems,
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  resolveComposerMenuSelection,
  useComposerCommandMenu,
} from "./use-composer-command-menu";

describe("resolveComposerMenuSelection", () => {
  it("prefers the caret an insertion placed in the current draft text", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hello @chip ",
        ownerKey: "draft-a",
        inserted: { start: 12, end: 12 },
        local: { ownerKey: "draft-a", start: 2, end: 2 },
      }),
    ).toEqual({ start: 12, end: 12 });
  });

  it("clamps the composer's own caret when the draft shrinks", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hi",
        ownerKey: "draft-a",
        inserted: null,
        local: { ownerKey: "draft-a", start: 5, end: 9 },
      }),
    ).toEqual({ start: 2, end: 2 });
  });

  it("starts at the end of the draft after switching owners", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "other draft",
        ownerKey: "draft-b",
        inserted: null,
        local: { ownerKey: "draft-a", start: 1, end: 1 },
      }),
    ).toEqual({ start: 11, end: 11 });
  });
});

describe("mobile slash commands", () => {
  it("keeps a provider's native /plan", () => {
    const items = buildComposerSlashCommandItems({
      query: "pl",
      atMessageStart: true,
      hasThread: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("antigravity"),
        slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
      },
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
      }),
    ).toEqual({ text: "/plan ", cursor: 6 });
  });

  it("offers T3's /clear in place of the provider's, only at the message start", () => {
    const claude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      slashCommands: [{ name: "clear", description: "Clear conversation history" }],
    };
    const build = (offersFreshSession: boolean, atMessageStart = true) =>
      buildComposerSlashCommandItems({
        query: "cle",
        atMessageStart,
        hasThread: true,
        offersFreshSession,
        selectedProviderStatus: claude,
      }).map((item) => item.id);
    expect(build(true)).toEqual(["cmd:clear"]);
    expect(build(false)).toEqual(["pcmd:clear"]);
    expect(build(true, false)).toEqual([]);
  });
});

describe("mobile model mentions", () => {
  const provider = (
    instanceId: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const option = (key: string, overrides: Partial<ModelOption> = {}): ModelOption => {
    const [instanceId = "", model = ""] = key.split(":");
    return {
      key,
      label: "GPT-6.1",
      subtitle: "",
      providerKey: instanceId,
      providerLabel: "Traex",
      providerDriver: "codex",
      isDefault: false,
      isLegacy: false,
      capabilities: null,
      selection: { instanceId: ProviderInstanceId.make(instanceId), model },
      ...overrides,
    };
  };

  it("offers current, visible models labelled with their provider", () => {
    const items = buildComposerModelItems(
      [
        option("traex:gpt-6.1"),
        option("opencode:traex/gpt-6.1", {
          subtitle: "Traex",
          providerLabel: "OpenCode",
          providerDriver: "opencode",
        }),
        option("hidden:gpt-6.1", { isHidden: true }),
        option("gone:gpt-6.1", { isUnavailable: true }),
        option("old:gpt-5", { label: "GPT-5", isLegacy: true }),
      ],
      "gpt",
      ["traex", "opencode", "hidden", "gone", "old"].map((id) => provider(id)),
    );
    expect(items.map((item) => [item.id, item.description]).toSorted()).toEqual([
      ["model:opencode:traex/gpt-6.1", "OpenCode · Traex"],
      ["model:traex:gpt-6.1", "Traex"],
    ]);
  });

  it.each([
    ["missing", []],
    ["not installed", [provider("traex", { installed: false })]],
    ["signed out", [provider("traex", { auth: { status: "unauthenticated" } })]],
    ["not ready", [provider("traex", { status: "error" })]],
    ["unavailable", [provider("traex", { availability: "unavailable" })]],
  ] as const)("does not suggest a preserved selection whose provider is %s", (_, providers) => {
    expect(buildComposerModelItems([option("traex:gpt-6.1")], "gpt", providers)).toEqual([]);
  });
});

describe("a mention search with spaces", () => {
  type MenuInput = Parameters<typeof useComposerCommandMenu>[0];

  async function mountMenu(options: Partial<MenuInput> = {}) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    let menu: ReturnType<typeof useComposerCommandMenu> | null = null;
    function Probe(props: { readonly text: string; readonly ownerKey: string }) {
      const value = useComposerCommandMenu({
        draftMessage: props.text,
        ownerKey: props.ownerKey,
        environmentId: null,
        projectCwd: null,
        selectedProviderStatus: null,
        hasThread: false,
        hasCompactableConversation: false,
        onChangeDraftMessage: () => {},
        ...options,
      });
      useLayoutEffect(() => {
        menu = value;
      });
      return null;
    }
    return {
      /** Renders the draft with the caret at its end, as typing leaves it. */
      type: async (text: string, ownerKey = "draft-a") => {
        await act(() => root.render(createElement(Probe, { text, ownerKey })));
        await act(() => menu!.onSelectionChange({ start: text.length, end: text.length }));
        return menu!;
      },
      [Symbol.asyncDispose]: async () => {
        await act(() => root.unmount());
        vi.unstubAllGlobals();
        vi.mocked(useComposerPathSearch).mockReset();
      },
    };
  }

  const pathSearch = (isPending: boolean, paths: ReadonlyArray<string>) =>
    vi.mocked(useComposerPathSearch).mockReturnValue({
      entries: paths.map((path) => ({ path, kind: "file" as const })),
      error: null,
      isPending,
      truncated: false,
      refresh: vi.fn(),
    });

  const olderThreads = (hasOlderRows: boolean) =>
    vi
      .mocked(useThreadSearch)
      .mockReturnValue({ matches: [], query: "", isPending: false, hasOlderRows });

  it("stays open across a space while a result contains the typed text", async () => {
    pathSearch(false, ["Foreign Subsidiaries/Script Notes.md", "Foreign.md"]);
    await using menu = await mountMenu({
      environmentId: EnvironmentId.make("local"),
      environments: [
        { environmentId: EnvironmentId.make("remote"), label: "Foreign Server", machine: "server" },
      ],
    });
    await menu.type("Open @Foreign");
    const spaced = await menu.type("Open @Foreign S");
    expect(spaced.trigger).toMatchObject({ query: "Foreign S", rangeStart: 5, rangeEnd: 15 });
    expect(spaced.items.map((item) => item.label)).toEqual(["Foreign Server", "Script Notes.md"]);
    // Another draft's search is not continued into this one.
    expect((await menu.type("Open @Foreign S", "draft-b")).trigger).toBeNull();
  });

  it("refuses a fuzzy result for prose and ends the search once results settle", async () => {
    const onChangeDraftMessage = vi.fn();
    pathSearch(false, ["ChatComposer.tsx"]);
    await using menu = await mountMenu({ onChangeDraftMessage });
    const stale = (await menu.type("Fix @ChatComposer")).items[0]!;

    pathSearch(true, ["ChatComposer.tsx"]);
    const pending = await menu.type("Fix @ChatComposer so");
    expect(pending.trigger?.query).toBe("ChatComposer so");
    expect(pending.items).toEqual([]);
    await act(() => pending.onSelect(stale));
    expect(onChangeDraftMessage).not.toHaveBeenCalled();

    pathSearch(false, ["ChatComposer.tsx"]);
    // An older thread the search found is not in the shells yet, so the search stays open for it.
    olderThreads(true);
    expect((await menu.type("Fix @ChatComposer so")).trigger?.query).toBe("ChatComposer so");
    olderThreads(false);
    expect((await menu.type("Fix @ChatComposer so")).trigger).toBeNull();
    expect((await menu.type("Fix @ChatComposer so that")).trigger).toBeNull();
  });
});
