import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const permissions = vi.hoisted(() => ({ canWriteSettings: false }));

vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => permissions.canWriteSettings,
  useEnvironmentScope: () => permissions.canWriteSettings,
}));
vi.mock("./ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "div",
  DialogFooter: "div",
  DialogHeader: "div",
  DialogPanel: "div",
  DialogPopup: "div",
  DialogTitle: "div",
}));
vi.mock("./ui/alert-dialog", () => ({
  AlertDialog: "div",
  AlertDialogClose: "button",
  AlertDialogDescription: "div",
  AlertDialogFooter: "div",
  AlertDialogHeader: "div",
  AlertDialogPopup: "div",
  AlertDialogTitle: "div",
}));
vi.mock("./ui/popover", () => ({
  Popover: "div",
  PopoverPopup: "div",
  PopoverTrigger: "button",
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/label", () => ({ Label: "label" }));
vi.mock("./ui/switch", () => ({ Switch: "input" }));
vi.mock("./ui/textarea", () => ({ Textarea: "textarea" }));

import {
  ProjectScriptEditorDialog,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const request: ProjectScriptEditorRequest = {
  scriptId: "test",
  initial: {
    name: "Test",
    command: "vp test",
    icon: "test",
    runOnWorktreeCreate: false,
    keybinding: "mod+k",
    previewUrl: null,
    autoOpenPreview: false,
  },
};

describe("ProjectScriptEditorDialog", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    permissions.canWriteSettings = false;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  async function openEditor(
    onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    editorRequest = request,
  ) {
    await act(() => {
      renderer = create(
        <ProjectScriptEditorDialog
          environmentId={EnvironmentId.make("script-editor-test")}
          request={editorRequest}
          scripts={[]}
          onSubmit={onSubmit}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    return renderer!.root;
  }

  it("clears an old shortcut when adding an action with no shortcut", async () => {
    permissions.canWriteSettings = true;
    let persistedKeybinding: string | null = "mod+k";
    const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
      if (input.keybinding !== undefined) persistedKeybinding = input.keybinding;
      return AsyncResult.success(undefined);
    });
    const root = await openEditor(onSubmit, {
      scriptId: null,
      initial: { ...request.initial, keybinding: null },
    });

    await act(async () => {
      await root.findByType("form").props.onSubmit({ preventDefault() {} });
    });

    expect(persistedKeybinding).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith(null, expect.objectContaining({ keybinding: null }));
  });

  it.each([false, true])(
    "preserves a concurrent shortcut change when saving only the script (settings access: %s)",
    async (canWriteSettings) => {
      permissions.canWriteSettings = canWriteSettings;
      const persisted = { name: request.initial.name, keybinding: request.initial.keybinding };
      const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
        persisted.name = input.name;
        if (input.keybinding !== undefined) persisted.keybinding = input.keybinding;
        return AsyncResult.success(undefined);
      });
      const root = await openEditor(onSubmit);

      // A second client changes the shortcut after this dialog snapshots it.
      persisted.keybinding = "mod+j";
      await act(() => {
        root.findByProps({ id: "script-name" }).props.onChange({ target: { value: "Renamed" } });
      });
      await act(async () => {
        await root.findByType("form").props.onSubmit({ preventDefault() {} });
      });

      expect(persisted).toEqual({ name: "Renamed", keybinding: "mod+j" });
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "enforces settings access when submitting an explicit shortcut clear (revoked: %s)",
    async (revokeBeforeSubmit) => {
      permissions.canWriteSettings = true;
      const onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      const root = await openEditor(onSubmit);
      await act(() => {
        root.findByProps({ id: "script-keybinding" }).props.onKeyDown({
          key: "Backspace",
          preventDefault() {},
        });
      });
      if (revokeBeforeSubmit) permissions.canWriteSettings = false;
      await act(async () => {
        await root.findByType("form").props.onSubmit({ preventDefault() {} });
      });

      if (revokeBeforeSubmit) {
        expect(onSubmit).not.toHaveBeenCalled();
      } else {
        expect(onSubmit).toHaveBeenCalledWith(
          "test",
          expect.objectContaining({ keybinding: null }),
        );
      }
    },
  );
});
