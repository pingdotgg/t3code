import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { createDraft } from "./scheduledTaskDraft";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  readScheduledTaskEditor,
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
  takeScheduledTaskNewLink,
  updateScheduledTaskEditor,
} from "./scheduled-task-editor-state";

afterEach(() => appAtomRegistry.set(scheduledTaskEditorSessionAtom, null));

describe("scheduled task voice draft", () => {
  const editor = {
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: createDraft(null, null),
  };

  it("keeps the prompt outside the screen and retains its original change baseline", () => {
    startScheduledTaskEditor(editor);
    const original = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    const ownerKey = `scheduled-task:${original.id}`;
    updateScheduledTaskEditor(
      (current) =>
        current && {
          ...current,
          draft: { ...current.draft, prompt: "spoken prompt" },
        },
      null,
    );

    expect(readScheduledTaskEditor(ownerKey, null)?.draft.prompt).toBe("spoken prompt");
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.initial).toBe(editor);
  });

  it("rejects an old voice target when another task opens in the same environment", () => {
    startScheduledTaskEditor(editor);
    const original = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    startScheduledTaskEditor({ ...editor, draft: { ...editor.draft, prompt: "other task" } });

    expect(readScheduledTaskEditor(`scheduled-task:${original.id}`, editor)).toBeNull();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.prompt).toBe(
      "other task",
    );
  });

  it("does not restore the default prompt after the editor is discarded", () => {
    startScheduledTaskEditor(null);
    const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    expect(readScheduledTaskEditor(`scheduled-task:${session.id}`, editor)).toBeNull();
    updateScheduledTaskEditor((current) => current, editor);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBeNull();
  });
});

describe("new scheduled task link", () => {
  const editing = {
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: createDraft(null, null),
  };
  const newTaskLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [{ name: "SettingsScheduledTasks" }, { name: "SettingsScheduledTaskNew" }],
        },
      },
    ],
  };

  it("drops the last edited task so the new-task screen starts from the default", () => {
    startScheduledTaskEditor(editing);
    expect(takeScheduledTaskNewLink(newTaskLink)).toBe(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("keeps unsaved changes until the editor's removal guard discards them", () => {
    startScheduledTaskEditor(editing);
    const edited = { ...editing, draft: { ...editing.draft, prompt: "unsaved" } };
    updateScheduledTaskEditor(edited, null);

    takeScheduledTaskNewLink(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBe(edited);

    discardScheduledTaskEditor();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("starts the new-task screen fresh after the edited task was saved", () => {
    startScheduledTaskEditor(editing);
    updateScheduledTaskEditor({ ...editing, draft: { ...editing.draft, prompt: "saved" } }, null);
    markScheduledTaskEditorSaved();

    takeScheduledTaskNewLink(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("closes a discarded editor as empty when no new-task link is waiting", () => {
    startScheduledTaskEditor(editing);
    discardScheduledTaskEditor();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBeNull();
  });

  it("keeps the editor for links to other screens", () => {
    startScheduledTaskEditor(editing);
    takeScheduledTaskNewLink({ routes: [{ name: "SettingsSheet" }] });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBe(editing);
  });
});
