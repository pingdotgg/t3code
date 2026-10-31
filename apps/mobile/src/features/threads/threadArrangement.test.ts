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
  it("does not repeat a confirmed settle when its server timestamp differs from the preview", () => {
    const saved = [
      thread("a", { pinnedAt: NOW, pinOrderKey: "g", snoozedUntil: "2099-01-01T00:00:00.000Z" }),
    ];
    const [draft] = applyThreadMove(saved, key(saved[0]!), { section: "settled" }, NOW);
    const confirmed = { ...draft!, settledAt: "2026-10-15T12:00:00.001Z" };

    expect(threadArrangementCommands(confirmed, draft!)).toEqual([]);
  });

  it("wakes an already pinned thread when dropped into Pinned", () => {
    const saved = [
      thread("a", { pinnedAt: NOW, pinOrderKey: "g", snoozedUntil: "2099-01-01T00:00:00.000Z" }),
    ];
    const draft = applyThreadMove(
      saved,
      key(saved[0]!),
      {
        section: "pinned",
        assignments: [{ id: key(saved[0]!), orderKey: "m" }],
      },
      NOW,
    );

    expect(draft[0]!.snoozedUntil).toBeNull();
    expect(commandsFor(saved, draft)).toEqual({
      a: [{ type: "unsnooze" }, { type: "reorderPin", orderKey: "m" }],
    });
  });

  it("previews a newly settled thread at its new settlement time", () => {
    const saved = [thread("a", { settledAt: "2026-09-01T00:00:00.000Z" })];
    const draft = applyThreadMove(saved, key(saved[0]!), { section: "settled" }, NOW);

    const shown = withThreadDrafts(saved, recordThreadMove(new Map(), saved, draft));
    expect(shown[0]!.settledAt).toBe(NOW);
    expect(commandsFor(saved, draft)).toEqual({ a: [{ type: "settle" }] });
  });

  it.each([null, "settled"] as const)(
    "settling clears snooze with saved override %s",
    (settledOverride) => {
      const saved = [thread("a", { settledOverride, snoozedUntil: "2099-01-01T00:00:00.000Z" })];
      const draft = applyThreadMove(saved, key(saved[0]!), { section: "settled" }, NOW);

      expect(draft[0]!.snoozedUntil).toBeNull();
      expect(commandsFor(saved, draft)).toEqual({ a: [{ type: "settle" }] });
    },
  );

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

  it.each(["settled", null] as const)(
    "pins a thread settled before saving (%s), carrying its slot",
    (settledOverride) => {
      const saved = [thread("a", { settledOverride, settledAt: NOW })];
      const draft = applyThreadMove(
        saved,
        key(saved[0]!),
        {
          section: "pinned",
          assignments: [{ id: key(saved[0]!), orderKey: "p3" }],
        },
        NOW,
      );

      const live = [{ ...saved[0]!, settledOverride: "settled" as const }];
      const shown = withThreadDrafts(live, recordThreadMove(new Map(), saved, draft));
      expect(shown[0]).toMatchObject({
        pinnedAt: NOW,
        settledOverride: "active",
        snoozedUntil: null,
      });
      expect(commandsFor(live, shown)).toEqual({ a: [{ type: "pin", orderKey: "p3" }] });
    },
  );

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
