import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useComposerPathSearch, useThreadSearch } from "../../state/queries";
import { useComposerDraftSelection } from "../../state/use-composer-drafts";
import { makeThreadShellFixture } from "../../test-fixtures";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useThreadSearch: vi.fn(() => ({ matches: [], query: "", isPending: false })),
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

  it("continues a spaced model label without a matching filesystem path", async () => {
    await using state = await mountMenu("@GPT", { start: 4, end: 4 }, undefined, {
      modelOptions: [option("traex:gpt-6.1", { label: "GPT Six" })],
      modelProviders: [provider("traex")],
    });
    await state.renderDraft("@GPT ", { start: 5, end: 5 });
    expect(state.menu.trigger?.query).toBe("GPT ");
    expect(state.menu.items.some((item) => item.type === "model")).toBe(true);
  });

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

async function mountMenu(
  draftMessage: string,
  selection: { start: number; end: number },
  threadShells?: Parameters<typeof useComposerCommandMenu>[0]["threadShells"],
  options: Partial<Parameters<typeof useComposerCommandMenu>[0]> = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let menu: ReturnType<typeof useComposerCommandMenu> | undefined;
  function Probe({ text, ownerKey }: { text: string; ownerKey: string }) {
    const value = useComposerCommandMenu({
      draftMessage: text,
      ownerKey,
      environmentId: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasThread: false,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
      ...(threadShells ? { threadShells } : {}),
      ...options,
    });
    useLayoutEffect(() => {
      menu = value;
    });
    return null;
  }
  const dispose = async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.mocked(useComposerDraftSelection).mockReset();
    vi.mocked(useComposerPathSearch).mockReset();
    vi.mocked(useThreadSearch).mockReset();
  };
  const renderDraft = async (
    text: string,
    caret: { start: number; end: number },
    ownerKey = "draft-a",
  ) => {
    vi.mocked(useComposerDraftSelection).mockReturnValue(caret);
    await act(() => root.render(createElement(Probe, { text, ownerKey })));
    if (!menu) throw new Error("Composer menu did not mount");
    return menu;
  };
  try {
    await renderDraft(draftMessage, selection);
    return {
      renderDraft,
      get menu() {
        return menu!;
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

it("keeps the picker closed when mounting with a selected mention", async () => {
  await using state = await mountMenu("@foo", { start: 0, end: 4 });
  expect(state.menu.trigger).toBeNull();
  expect(state.menu.items).toEqual([]);
});

it("uses the restored caret when switching draft owners", async () => {
  await using state = await mountMenu("@first", { start: 6, end: 6 });
  const menu = await state.renderDraft("@foo suffix @last", { start: 4, end: 4 }, "draft-b");
  expect(menu.trigger).toMatchObject({ query: "foo", rangeStart: 0, rangeEnd: 4 });
});

it("keeps a spaced search open while a thread title or capped results may match it", async () => {
  const typeQuery = async (state: Awaited<ReturnType<typeof mountMenu>>, query: string) => {
    for (let end = 2; end <= query.length; end += 1) {
      await state.renderDraft(query.slice(0, end), { start: end, end });
    }
    return state.menu.trigger?.query;
  };
  await using threads = await mountMenu(
    "@",
    { start: 1, end: 1 },
    [makeThreadShellFixture({ title: "Quarterly Planning" })],
    { environmentId: EnvironmentId.make("environment-test") },
  );
  expect(await typeQuery(threads, "@Quarterly Pl")).toBe("Quarterly Pl");

  vi.mocked(useComposerPathSearch).mockReturnValue({
    entries: [{ path: "Foreign Alpha 000.md" }],
    isPending: false,
    truncated: true,
  } as unknown as ReturnType<typeof useComposerPathSearch>);
  await using capped = await mountMenu("@", { start: 1, end: 1 });
  expect(await typeQuery(capped, "@Foreign Ze")).toBe("Foreign Ze");
});

it("rejects pending fuzzy selections and revalidates when the same query settles", async () => {
  const onChangeDraftMessage = vi.fn();
  const entry = { path: "ChatComposer.tsx", kind: "file" as const };
  vi.mocked(useComposerPathSearch).mockReturnValue({
    entries: [entry],
    error: null,
    refresh: vi.fn(),
    isPending: true,
    truncated: false,
  });
  await using state = await mountMenu("Fix @ChatComposer", { start: 17, end: 17 }, undefined, {
    onChangeDraftMessage,
  });
  const text = "Fix @ChatComposer so";
  await state.renderDraft(text, { start: text.length, end: text.length });
  const item = state.menu.items.find((item) => item.type === "path")!;
  await act(() => state.menu.onSelect(item));
  expect.soft(onChangeDraftMessage).not.toHaveBeenCalled();
  vi.mocked(useComposerPathSearch).mockReturnValue({
    entries: [entry],
    error: null,
    refresh: vi.fn(),
    isPending: false,
    truncated: false,
  });
  await state.renderDraft(text, { start: text.length, end: text.length });
  expect(state.menu.trigger).toBeNull();
  expect(state.menu.items).toEqual([]);
});

it("continues a spaced machine name when filesystem results do not contain it", async () => {
  const environmentId = EnvironmentId.make("local");
  await using state = await mountMenu("@Build", { start: 6, end: 6 }, undefined, {
    environmentId,
    environments: [
      { environmentId: EnvironmentId.make("remote"), label: "Build Server", machine: "server" },
    ],
  });
  await state.renderDraft("@Build ", { start: 7, end: 7 });
  expect(state.menu.trigger?.query).toBe("Build ");
  expect(state.menu.items.some((item) => item.type === "environment")).toBe(true);
});

it("keeps continuation while only the remote thread search is pending", async () => {
  vi.mocked(useThreadSearch).mockReturnValue({ matches: [], query: "Design", isPending: true });
  await using state = await mountMenu("@Design", { start: 7, end: 7 });
  await state.renderDraft("@Design Review", { start: 14, end: 14 });
  expect(state.menu.trigger?.query).toBe("Design Review");
});
