import { TaskDocumentId, type OpenTaskDocument } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { TaskDocumentSession } from "./taskDocumentSession.ts";

function document(contents: string, revision: string, locatorVersion = 0): OpenTaskDocument {
  return {
    contents,
    revision: revision.repeat(64),
    summary: {
      taskDocumentId: TaskDocumentId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      canonicalPath: "/tasks/task.md",
      locatorVersion,
      observedFileId: null,
      registered: true,
      title: "Task",
      state: "review",
      pinned: false,
      availability: "available",
      revision: revision.repeat(64),
    },
  };
}

describe("task document sessions", () => {
  it("refreshes clean text but retains base, draft and disk across external edits and failures", () => {
    const session = new TaskDocumentSession();
    const base = document("base", "a");
    session.acceptRead(session.beginRead(), base);
    session.acceptRead(session.beginRead(), document("clean update", "b"));
    expect(session.getSnapshot().draft).toBe("clean update");
    session.edit("my draft");
    const disk = document("external update", "c");
    session.acceptRead(session.beginRead(), disk);
    session.failRead(session.beginRead(), "Disconnected");
    expect(session.getSnapshot()).toMatchObject({
      base: { contents: "clean update" },
      draft: "my draft",
      disk,
      error: "Disconnected",
    });
    expect(session.beginSave()).toBeNull();
    session.keepDraft();
    const save = session.beginSave();
    expect(save?.input).toMatchObject({
      expectedRevision: disk.revision,
      baseContents: disk.contents,
      contents: "my draft",
    });
    expect(session.getSnapshot().recovery).toMatchObject({
      base: { contents: "clean update" },
      draft: "my draft",
      disk,
    });
    session.acceptSave(save!, document("my draft", "d"));
    expect(session.getSnapshot().recovery).toBeNull();
  });

  it("isolates late reads and saves, including edits made while a save is pending", () => {
    const a = new TaskDocumentSession();
    const b = new TaskDocumentSession();
    const oldRead = a.beginRead();
    a.acceptRead(a.beginRead(), document("base A", "a"));
    b.acceptRead(b.beginRead(), document("base B", "b"));
    a.edit("save A");
    a.setView({ editor: "cursor at 3", scrollTop: 90 });
    const save = a.beginSave()!;
    expect(a.beginSave()).toBeNull();
    const racingRead = a.beginRead();
    a.edit("newer A");
    a.acceptSave(save, document("save A", "c"));
    a.acceptRead(oldRead, document("obsolete", "d"));
    a.acceptRead(racingRead, document("obsolete", "d"));
    expect(a.getSnapshot()).toMatchObject({
      base: { contents: "save A" },
      draft: "newer A",
      saving: false,
      view: { editor: "cursor at 3", scrollTop: 90, rendered: false },
    });
    expect(b.getSnapshot()).toMatchObject({ base: { contents: "base B" }, draft: "base B" });
    const retry = a.beginSave()!;
    a.failSave(retry, "Connection lost; inspect disk before saving again");
    a.acceptRead(a.beginRead(), document("server saved newer A", "e", 1));
    expect(a.getSnapshot()).toMatchObject({
      draft: "newer A",
      disk: { contents: "server saved newer A" },
    });
    expect(a.beginSave()).toBeNull();
    a.reloadDisk();
    expect(a.getSnapshot()).toMatchObject({ draft: "server saved newer A", disk: null });
    expect(a.getSnapshot().recovery?.draft).toBe("newer A");
    a.reverseRecovery();
    expect(a.getSnapshot()).toMatchObject({
      base: { contents: "server saved newer A" },
      draft: "newer A",
      recovery: null,
    });
    a.acceptRead(a.beginRead(), document("newest disk", "f", 1));
    a.keepDraft();
    expect(a.getSnapshot()).toMatchObject({
      base: { contents: "newest disk" },
      draft: "newer A",
      recovery: { keptDraft: true },
    });
    a.reverseRecovery();
    expect(a.getSnapshot()).toMatchObject({ draft: "newest disk", recovery: null });
  });
});
