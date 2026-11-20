import { describe, expect, it } from "vite-plus/test";

import {
  editSession,
  isDirty,
  keepMine,
  openSession,
  save,
  saved,
  takeTheirs,
} from "./saveSession";

describe("saveSession", () => {
  it("Given an edit and an unchanged disk, when saved, then it writes the edits", () => {
    const session = editSession(openSession("alpha\n"), "alpha\nbeta\n");

    expect(isDirty(session)).toBe(true);
    expect(save(session, "alpha\n")).toEqual({ kind: "write", contents: "alpha\nbeta\n" });
  });

  it("Given an edit and a disk that changed since open, when saved, then it reports the conflict with both sides", () => {
    const session = editSession(openSession("alpha\n"), "alpha\nmine\n");

    expect(save(session, "alpha\ntheirs\n")).toEqual({
      kind: "conflict",
      session: { opened: "alpha\n", edits: "alpha\nmine\n", disk: "alpha\ntheirs\n" },
    });
  });

  it("Given a conflict, when Keep mine is chosen, then it writes the edits over the new disk contents", () => {
    const step = save(editSession(openSession("alpha\n"), "alpha\nmine\n"), "alpha\ntheirs\n");
    if (step.kind !== "conflict") throw new Error("expected a conflict");

    expect(keepMine(step.session)).toEqual({ kind: "write", contents: "alpha\nmine\n" });
  });

  it("Given a conflict, when Take theirs is chosen, then the edits are discarded for the new disk contents", () => {
    const step = save(editSession(openSession("alpha\n"), "alpha\nmine\n"), "alpha\ntheirs\n");
    if (step.kind !== "conflict") throw new Error("expected a conflict");

    expect(takeTheirs(step.session)).toEqual({
      opened: "alpha\ntheirs\n",
      edits: "alpha\ntheirs\n",
      disk: null,
    });
  });

  it("Given a write that landed, when the session continues, then it opens the written contents", () => {
    expect(saved("alpha\nmine\n")).toEqual({
      opened: "alpha\nmine\n",
      edits: "alpha\nmine\n",
      disk: null,
    });
    expect(isDirty(saved("alpha\nmine\n"))).toBe(false);
  });
});
