import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
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

  it("replaces a model mention with prompt text and places the cursor after it", () => {
    const modelOption = option("codex:gpt-5.4");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "@gpt",
        trigger: { rangeStart: 0, rangeEnd: 4 },
        item: {
          id: `model:${modelOption.key}`,
          type: "model",
          option: modelOption,
          label: modelOption.label,
          description: modelOption.providerLabel,
        },
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "model:codex/gpt-5.4 ", cursor: 20, interactionMode: null });
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
