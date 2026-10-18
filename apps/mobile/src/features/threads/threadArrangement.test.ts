import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  applyThreadMove,
  recordThreadMove,
  threadArrangementCommands,
  withThreadDrafts,
} from "./threadOrder";

const NOW = "2026-10-15T12:00:00.000Z";

function thread(id: string, overrides: Parameters<typeof makeThreadShellFixture>[0] = {}) {
  return makeThreadShellFixture({
    id: ThreadId.make(id),
    settledOverride: null,
    snoozedUntil: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    ...overrides,
  });
}

const key = (shell: ReturnType<typeof thread>) => `${shell.environmentId}:${shell.id}`;

function commandsFor(
  saved: readonly ReturnType<typeof thread>[],
  draft: readonly ReturnType<typeof thread>[],
) {
  return Object.fromEntries(
    saved.map((shell, index) => [shell.id, threadArrangementCommands(shell, draft[index]!)]),
  );
}

describe("thread arrangement drafts", () => {
  it("sends one write per thread no matter how many times it moved", () => {
    const saved = [
      thread("a", { activeOrderKey: "a0" }),
      thread("b", { activeOrderKey: "a1" }),
      thread("c", { activeOrderKey: "a2" }),
    ];
    let draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "active",
        assignments: [{ id: key(saved[0]!), orderKey: "a1V" }],
      },
      NOW,
    );
    draft = applyThreadMove(
      draft,
      key(saved[0]!),
      {
        section: "active",
        assignments: [{ id: key(saved[0]!), orderKey: "a3" }],
      },
      NOW,
    );

    expect(commandsFor(saved, draft)).toEqual({
      a: [{ type: "reorderActive", orderKey: "a3" }],
      b: [],
      c: [],
    });
  });

  it("sends nothing for a thread pinned and unpinned within the draft", () => {
    const saved = [thread("a", { activeOrderKey: "a0" })];
    let draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "pinned",
        assignments: [{ id: key(saved[0]!), orderKey: "p0" }],
      },
      NOW,
    );
    draft = applyThreadMove(
      draft,
      key(saved[0]!),
      {
        section: "active",
        assignments: [{ id: key(saved[0]!), orderKey: "a0" }],
      },
      NOW,
    );

    expect(commandsFor(saved, draft)).toEqual({ a: [] });
  });

  it("unpins before writing the active slot", () => {
    const saved = [thread("a", { pinnedAt: NOW, pinOrderKey: "p0", activeOrderKey: "a0" })];
    const draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "active",
        assignments: [{ id: key(saved[0]!), orderKey: "a5" }],
      },
      NOW,
    );

    expect(commandsFor(saved, draft)).toEqual({
      a: [{ type: "unpin" }, { type: "reorderActive", orderKey: "a5" }],
    });
  });

  it("pins a settled thread in one command, carrying its slot", () => {
    const saved = [thread("a", { settledOverride: "settled", settledAt: NOW })];
    const draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "pinned",
        assignments: [{ id: key(saved[0]!), orderKey: "p3" }],
      },
      NOW,
    );

    expect(commandsFor(saved, draft)).toEqual({ a: [{ type: "pin", orderKey: "p3" }] });
  });

  it("settles without key writes, even after earlier draft moves", () => {
    const saved = [thread("a", { pinnedAt: NOW, pinOrderKey: "p0" })];
    let draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "pinned",
        assignments: [{ id: key(saved[0]!), orderKey: "p9" }],
      },
      NOW,
    );
    draft = applyThreadMove(draft, key(saved[0]!), { section: "settled" }, NOW);

    expect(commandsFor(saved, draft)).toEqual({ a: [{ type: "settle" }] });
  });

  it("keeps live fields current under a draft", () => {
    const saved = [thread("a", { activeOrderKey: "a0" })];
    const drafts = recordThreadMove(
      new Map(),
      saved,
      applyThreadMove(
        saved,
        key(saved[0]!),
        {
          section: "active",
          assignments: [{ id: key(saved[0]!), orderKey: "a7" }],
        },
        NOW,
      ),
    );
    const [shown] = withThreadDrafts([{ ...saved[0]!, title: "Renamed" }], drafts);

    expect(shown).toMatchObject({ title: "Renamed", activeOrderKey: "a7" });
  });

  it("does not revert server changes to fields the draft never touched", () => {
    const opened = [thread("a", { activeOrderKey: "a0" }), thread("b", { activeOrderKey: "a1" })];
    const drafts = recordThreadMove(
      new Map(),
      opened,
      applyThreadMove(
        opened,
        key(opened[1]!),
        {
          section: "active",
          assignments: [
            { id: key(opened[1]!), orderKey: "a0" },
            { id: key(opened[0]!), orderKey: "a1" },
          ],
        },
        NOW,
      ),
    );
    // While the sheet is open, the server auto-settles "a".
    const live = [{ ...opened[0]!, settledOverride: "settled" as const }, opened[1]!];
    const draft = withThreadDrafts(live, drafts);

    expect(commandsFor(live, draft)).toEqual({
      a: [],
      b: [{ type: "reorderActive", orderKey: "a0" }],
    });
  });
});
