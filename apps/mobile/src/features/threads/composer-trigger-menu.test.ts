import type { ServerProviderSkill } from "@t3tools/contracts";
import { detectComposerTrigger, type ComposerTrigger } from "@t3tools/shared/composerTrigger";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerMenuItems,
  nextComposerSelection,
  resolveComposerCommandSelection,
  type ComposerBuiltInCommand,
  type ComposerTriggerMenuProvider,
} from "./composer-trigger-menu";

const ALL_BUILT_INS: ReadonlyArray<ComposerBuiltInCommand> = ["model", "plan", "default"];

function makeSkill(
  name: string,
  overrides: Partial<ServerProviderSkill> = {},
): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}`,
    enabled: true,
    ...overrides,
  };
}

function makeProvider(
  overrides: Partial<ComposerTriggerMenuProvider> = {},
): ComposerTriggerMenuProvider {
  return { skills: [], slashCommands: [], ...overrides };
}

/** Trigger for `text` with the caret at its end, as the composer detects it. */
function triggerFor(text: string): ComposerTrigger {
  const trigger = detectComposerTrigger(text, text.length);
  if (!trigger) throw new Error(`no trigger for ${JSON.stringify(text)}`);
  return trigger;
}

describe("buildComposerMenuItems", () => {
  it("returns nothing without a trigger", () => {
    expect(
      buildComposerMenuItems({
        trigger: null,
        provider: makeProvider({ skills: [makeSkill("review")] }),
        builtInCommands: ALL_BUILT_INS,
        pathEntries: [],
      }),
    ).toEqual([]);
  });

  it("lists built-in commands before provider commands", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("/"),
      provider: makeProvider({
        slashCommands: [{ name: "review", description: "Review the diff" }, { name: "compact" }],
      }),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual([
      "cmd:model",
      "cmd:plan",
      "cmd:default",
      "pcmd:review",
      "pcmd:compact",
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "/model",
      "/plan",
      "/default",
      "/review",
      "/compact",
    ]);
    expect(items[3]?.description).toBe("Review the diff");
    expect(items[4]?.description).toBe("");
  });

  it("filters both lists by the typed command query", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("/mod"),
      provider: makeProvider({ slashCommands: [{ name: "Model-Check" }, { name: "compact" }] }),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual(["cmd:model", "pcmd:Model-Check"]);
  });

  it("omits built-ins the surface does not offer", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("/"),
      provider: makeProvider({ slashCommands: [{ name: "compact" }] }),
      builtInCommands: [],
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual(["pcmd:compact"]);
  });

  it("lists only enabled skills for a bare $ trigger", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("$"),
      provider: makeProvider({
        skills: [
          makeSkill("review", { displayName: "Review", shortDescription: "Read the diff" }),
          makeSkill("retired", { enabled: false }),
          makeSkill("ship"),
        ],
      }),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual(["skill:review", "skill:ship"]);
    expect(items[0]).toMatchObject({
      type: "skill",
      label: "Review",
      description: "Read the diff",
    });
    expect(items[1]).toMatchObject({ label: "ship", description: "" });
  });

  it("ranks skills by the query and drops non-matches", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("$rev"),
      provider: makeProvider({
        skills: [
          makeSkill("ship-it", { description: "reviews nothing" }),
          makeSkill("review-pr"),
          makeSkill("unrelated"),
        ],
      }),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual(["skill:review-pr", "skill:ship-it"]);
  });

  it("ignores extra $ characters in the skill query", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("$$review"),
      provider: makeProvider({ skills: [makeSkill("review-pr"), makeSkill("unrelated")] }),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [],
    });

    expect(items.map((item) => item.id)).toEqual(["skill:review-pr"]);
  });

  it("splits path entries into a basename label and a directory description", () => {
    const items = buildComposerMenuItems({
      trigger: triggerFor("@src"),
      provider: makeProvider(),
      builtInCommands: ALL_BUILT_INS,
      pathEntries: [
        { path: "apps/mobile/src/index.ts", kind: "file" },
        { path: "README.md", kind: "file" },
      ],
    });

    expect(items[0]).toMatchObject({
      id: "path:apps/mobile/src/index.ts",
      type: "path",
      kind: "file",
      label: "index.ts",
      description: "apps/mobile/src",
    });
    expect(items[1]).toMatchObject({ label: "README.md", description: "" });
  });

  it("offers nothing for the /model trigger, which has no menu", () => {
    expect(
      buildComposerMenuItems({
        trigger: triggerFor("/model "),
        provider: makeProvider({ slashCommands: [{ name: "compact" }] }),
        builtInCommands: ALL_BUILT_INS,
        pathEntries: [],
      }),
    ).toEqual([]);
  });
});

describe("resolveComposerCommandSelection", () => {
  it("inserts a markdown file link for a path", () => {
    const text = "look at @src";
    expect(
      resolveComposerCommandSelection({
        text,
        trigger: triggerFor(text),
        item: {
          id: "path:apps/mobile/src/index.ts",
          type: "path",
          path: "apps/mobile/src/index.ts",
          kind: "file",
          label: "index.ts",
          description: "apps/mobile/src",
        },
      }),
    ).toEqual({
      text: "look at [index.ts](apps/mobile/src/index.ts) ",
      cursor: "look at [index.ts](apps/mobile/src/index.ts) ".length,
      interactionMode: null,
    });
  });

  it("inserts a $-prefixed skill token", () => {
    const text = "run $rev";
    expect(
      resolveComposerCommandSelection({
        text,
        trigger: triggerFor(text),
        item: {
          id: "skill:review-pr",
          type: "skill",
          skill: makeSkill("review-pr", { displayName: "Review PR" }),
          label: "Review PR",
          description: "",
        },
      }),
    ).toEqual({ text: "run $review-pr ", cursor: 15, interactionMode: null });
  });

  it("inserts a provider slash command by name", () => {
    expect(
      resolveComposerCommandSelection({
        text: "/rev",
        trigger: triggerFor("/rev"),
        item: {
          id: "pcmd:review",
          type: "provider-slash-command",
          command: { name: "review" },
          label: "/review",
          description: "",
        },
      }),
    ).toEqual({ text: "/review ", cursor: 8, interactionMode: null });
  });

  it("keeps /model as typed text", () => {
    expect(
      resolveComposerCommandSelection({
        text: "/mod",
        trigger: triggerFor("/mod"),
        item: {
          id: "cmd:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "",
        },
      }),
    ).toEqual({ text: "/model ", cursor: 7, interactionMode: null });
  });

  it("drops the typed command and reports the interaction mode for /plan and /default", () => {
    for (const command of ["plan", "default"] as const) {
      expect(
        resolveComposerCommandSelection({
          text: `write it\n/${command.slice(0, 2)}`,
          trigger: triggerFor(`write it\n/${command.slice(0, 2)}`),
          item: {
            id: `cmd:${command}`,
            type: "slash-command",
            command,
            label: `/${command}`,
            description: "",
          },
        }),
      ).toEqual({ text: "write it\n", cursor: 9, interactionMode: command });
    }
  });
});

describe("nextComposerSelection", () => {
  it("clamps a caret past the end of the text", () => {
    const current = { start: 12, end: 12 };
    expect(nextComposerSelection({ current, textLength: 4, draftChanged: false })).toEqual({
      start: 4,
      end: 4,
    });
  });

  it("keeps a selection that still fits, by reference", () => {
    const current = { start: 1, end: 3 };
    expect(nextComposerSelection({ current, textLength: 4, draftChanged: false })).toBe(current);
  });

  it("parks the caret at the end when the draft changes", () => {
    expect(
      nextComposerSelection({ current: { start: 2, end: 2 }, textLength: 9, draftChanged: true }),
    ).toEqual({ start: 9, end: 9 });
  });

  it("drops a range selection carried over from the previous draft", () => {
    expect(
      nextComposerSelection({ current: { start: 0, end: 5 }, textLength: 5, draftChanged: true }),
    ).toEqual({ start: 5, end: 5 });
  });

  it("keeps the caret by reference when the new draft already ends there", () => {
    const current = { start: 3, end: 3 };
    expect(nextComposerSelection({ current, textLength: 3, draftChanged: true })).toBe(current);
  });

  it("parks the caret at 0 when the draft changes to empty text", () => {
    expect(
      nextComposerSelection({ current: { start: 7, end: 7 }, textLength: 0, draftChanged: true }),
    ).toEqual({ start: 0, end: 0 });
  });
});
