import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { createDraft } from "./scheduledTaskDraft";
import {
  readScheduledTaskEditor,
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
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
