import { Suspense } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

// The modal Settings dialog marks everything outside it inert in this harness, so the
// test drives the editor through the DOM instead of pointer actions.
async function editorElement<T extends HTMLElement>(selector: string): Promise<T> {
  await expect
    .poll(() => document.querySelector(`[data-theme-editor-panel] ${selector}`))
    .toBeTruthy();
  return document.querySelector<T>(`[data-theme-editor-panel] ${selector}`)!;
}

// The editor floats beside the Settings dialog, whose Esc handler sits on the document.
function SettingsWithEditor(props: {
  onSettingsOpenChange: (open: boolean) => void;
  onEditorOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <Dialog onOpenChange={props.onSettingsOpenChange} open>
        <DialogPopup>
          <DialogTitle>Settings</DialogTitle>
        </DialogPopup>
      </Dialog>
      <Suspense fallback={null}>
        <ThemeEditorPanel
          editingTheme={null}
          initialAppearance="light"
          onOpenChange={props.onEditorOpenChange}
          onSaved={() => true}
          open
          restoreTheme={() => undefined}
        />
      </Suspense>
    </>
  );
}

describe("Esc in the theme editor", () => {
  it("closes the editor, not Settings", async () => {
    const onSettingsOpenChange = vi.fn();
    const onEditorOpenChange = vi.fn();
    await using _screen = await render(
      <SettingsWithEditor
        onEditorOpenChange={onEditorOpenChange}
        onSettingsOpenChange={onSettingsOpenChange}
      />,
    );

    (await editorElement<HTMLInputElement>("input")).focus();
    await userEvent.keyboard("{Escape}");

    expect(onEditorOpenChange).toHaveBeenCalledWith(false);
    expect(onSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("cancels inspecting only", async () => {
    const onSettingsOpenChange = vi.fn();
    const onEditorOpenChange = vi.fn();
    await using _screen = await render(
      <SettingsWithEditor
        onEditorOpenChange={onEditorOpenChange}
        onSettingsOpenChange={onSettingsOpenChange}
      />,
    );

    (await editorElement('[aria-label="Inspect app colors"]')).click();
    await editorElement('[aria-label="Cancel inspecting app colors"]');
    await userEvent.keyboard("{Escape}");

    await editorElement('[aria-label="Inspect app colors"]');
    expect(onEditorOpenChange).not.toHaveBeenCalled();
    expect(onSettingsOpenChange).not.toHaveBeenCalled();
  });
});
