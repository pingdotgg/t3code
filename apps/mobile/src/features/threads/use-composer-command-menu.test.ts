import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

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

import {
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
  it.each(["code-review", "simplify", "run"])(
    "offers Claude's /%s after other text without changing the prefix on selection",
    (name) => {
      const prefix = "please run ";
      const draftMessage = `${prefix}/${name.slice(0, 3)}`;
      const items = buildComposerSlashCommandItems({
        query: name.slice(0, 3),
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: false,
        selectedProviderStatus: {
          driver: ProviderDriverKind.make("claudeAgent"),
          slashCommands: [{ name }, { name: "verify" }, { name: "compact" }],
        },
      });
      const item = items.find((candidate) => candidate.type === "provider-slash-command");
      expect(item?.label).toBe(`/${name}`);
      if (!item) throw new Error("Missing inline Claude skill");
      const text = `${prefix}/${name} `;
      expect(
        resolveComposerCommandSelection({
          draftMessage,
          trigger: { rangeStart: prefix.length, rangeEnd: draftMessage.length },
          item,
          allowInteractionMode: false,
        }),
      ).toEqual({ text, cursor: text.length, interactionMode: null });
    },
  );

  it.each(["claudeAgent", "codex"])("keeps %s native commands at the message start", (driver) => {
    const input = {
      query: "",
      atMessageStart: false,
      hasThread: true,
      hasCompactableConversation: true,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make(driver),
        slashCommands: [{ name: "verify" }, { name: "compact" }],
      },
    };
    const names = (atMessageStart: boolean) =>
      buildComposerSlashCommandItems({ ...input, atMessageStart })
        .filter((item) => item.type === "provider-slash-command")
        .map((item) => item.command.name);
    expect(names(false)).toEqual([]);
    expect(names(true)).toEqual(["verify", "compact"]);
  });

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
