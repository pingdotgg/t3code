import { act, render, type Screen } from "../../test/render";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const permissions = vi.hoisted(() => ({
  canWriteSettings: false,
  canEditProject: true,
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const read = (scope: AuthEnvironmentScope) =>
    scope === AuthOrchestrationOperateScope
      ? permissions.canEditProject
      : permissions.canWriteSettings;
  return {
    ...(await original()),
    readEnvironmentScope: (_id: EnvironmentId, scope: AuthEnvironmentScope) => read(scope),
    useEnvironmentScope: (_id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          permissions.listeners.add(listener);
          return () => permissions.listeners.delete(listener);
        },
        () => read(scope),
      ),
  };
});

/** A grant change that React has already rendered, unlike a bare assignment. */
const publish = () => act(async () => permissions.listeners.forEach((listener) => listener()));
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
    waitForSetup: false,
    runOnSettle: false,
    keybinding: "mod+k",
    previewUrl: null,
    autoOpenPreview: false,
  },
};

describe("ProjectScriptEditorDialog", () => {
  function setup() {
    permissions.canWriteSettings = false;
    permissions.canEditProject = true;
    permissions.listeners.clear();
  }

  async function openEditor(
    screen: Screen,
    onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined)),
    editorRequest = request,
    actions = { onDelete: vi.fn(), onClose: vi.fn() },
    editScope:
      | typeof AuthOrchestrationOperateScope
      | typeof AuthSettingsWriteScope = AuthOrchestrationOperateScope,
  ) {
    await screen.rerender(
      <ProjectScriptEditorDialog
        environmentId={EnvironmentId.make("script-editor-test")}
        editScope={editScope}
        request={editorRequest}
        scripts={[]}
        onSubmit={onSubmit}
        onDelete={actions.onDelete}
        onClose={actions.onClose}
      />,
    );
  }

  const submit = () => act(async () => document.querySelector("form")!.requestSubmit());
  async function click(label: string) {
    const button = await vi.waitFor(() => {
      const match = [...document.querySelectorAll("button")].find(
        (element) => element.textContent === label,
      );
      expect(match, label).toBeDefined();
      return match!;
    });
    await act(async () => button.click());
  }
  const confirmation = () => document.querySelector('[role="alertdialog"]');
  async function pressInShortcutField(keys: string) {
    document.querySelector<HTMLInputElement>("#script-keybinding")!.focus();
    await userEvent.keyboard(keys);
  }

  it.each([null, "test"])(
    "saves a settings action without task access (id: %s)",
    async (scriptId) => {
      setup();
      await using screen = await render(null);
      permissions.canEditProject = false;
      permissions.canWriteSettings = true;
      const onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      await openEditor(
        screen,
        onSubmit,
        { ...request, scriptId },
        undefined,
        AuthSettingsWriteScope,
      );
      permissions.canWriteSettings = false;
      await submit();
      expect(onSubmit).not.toHaveBeenCalled();
      permissions.canWriteSettings = true;
      await submit();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
        scriptId,
        expect.objectContaining({ command: "vp test" }),
      );
    },
  );

  it("rechecks settings access before deleting a settings action", async () => {
    setup();
    await using screen = await render(null);
    permissions.canEditProject = false;
    permissions.canWriteSettings = true;
    const actions = { onDelete: vi.fn(), onClose: vi.fn() };
    await openEditor(screen, undefined, request, actions, AuthSettingsWriteScope);
    await click("Delete");
    permissions.canWriteSettings = false;
    await click("Delete action");
    expect(actions.onDelete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(confirmation()).toBeNull());
    permissions.canWriteSettings = true;
    await publish();
    await click("Delete");
    await click("Delete action");
    expect(actions.onDelete).toHaveBeenCalledExactlyOnceWith(request.scriptId);
  });

  it("clears an old shortcut when adding an action with no shortcut", async () => {
    setup();
    await using screen = await render(null);
    permissions.canWriteSettings = true;
    let persistedKeybinding: string | null = "mod+k";
    const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
      if (input.keybinding !== undefined) persistedKeybinding = input.keybinding;
      return AsyncResult.success(undefined);
    });
    await openEditor(screen, onSubmit, {
      scriptId: null,
      initial: { ...request.initial, keybinding: null },
    });

    await submit();

    expect(persistedKeybinding).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith(null, expect.objectContaining({ keybinding: null }));
  });

  it.each([false, true])(
    "re-adds a deleted action while preserving its shortcut without settings access (revoked: %s)",
    async (revokeBeforeSubmit) => {
      setup();
      await using screen = await render(null);
      permissions.canWriteSettings = revokeBeforeSubmit;
      const persisted = { name: null as string | null, keybinding: "mod+k" as string | null };
      const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
        if (input.keybinding !== undefined && !permissions.canWriteSettings) {
          return AsyncResult.failure(
            Cause.fail(new Error("This connection cannot change keyboard shortcuts.")),
          );
        }
        persisted.name = input.name;
        if (input.keybinding !== undefined) persisted.keybinding = input.keybinding;
        return AsyncResult.success(undefined);
      });
      await openEditor(screen, onSubmit, {
        scriptId: null,
        initial: { ...request.initial, keybinding: null },
      });

      permissions.canWriteSettings = false;
      await submit();

      expect(persisted).toEqual({ name: "Test", keybinding: "mod+k" });
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "requires settings access to override a retained shortcut when re-adding an action (revoked: %s)",
    async (revokeBeforeSubmit) => {
      setup();
      await using screen = await render(null);
      permissions.canWriteSettings = true;
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
      const persisted = { name: null as string | null, keybinding: "mod+k" as string | null };
      const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
        persisted.name = input.name;
        if (input.keybinding !== undefined) persisted.keybinding = input.keybinding;
        return AsyncResult.success(undefined);
      });
      await openEditor(screen, onSubmit, {
        scriptId: null,
        initial: { ...request.initial, keybinding: null },
      });
      await pressInShortcutField("{Control>}j{/Control}");
      if (revokeBeforeSubmit) permissions.canWriteSettings = false;
      await submit();

      expect(persisted).toEqual(
        revokeBeforeSubmit
          ? { name: null, keybinding: "mod+k" }
          : { name: "Test", keybinding: "mod+j" },
      );
    },
  );

  it.each([false, true])(
    "preserves a concurrent shortcut change when saving only the script (settings access: %s)",
    async (canWriteSettings) => {
      setup();
      await using screen = await render(null);
      permissions.canWriteSettings = canWriteSettings;
      const persisted = { name: request.initial.name, keybinding: request.initial.keybinding };
      const onSubmit = vi.fn(async (_id: string | null, input: NewProjectScriptInput) => {
        persisted.name = input.name;
        if (input.keybinding !== undefined) persisted.keybinding = input.keybinding;
        return AsyncResult.success(undefined);
      });
      await openEditor(screen, onSubmit);

      persisted.keybinding = "mod+j";
      const name = document.querySelector<HTMLInputElement>("#script-name")!;
      await userEvent.clear(name);
      await userEvent.type(name, "Renamed");
      await submit();

      expect(persisted).toEqual({ name: "Renamed", keybinding: "mod+j" });
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "enforces settings access when submitting an explicit shortcut clear (revoked: %s)",
    async (revokeBeforeSubmit) => {
      setup();
      await using screen = await render(null);
      permissions.canWriteSettings = true;
      const onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      await openEditor(screen, onSubmit);
      await pressInShortcutField("{Backspace}");
      if (revokeBeforeSubmit) permissions.canWriteSettings = false;
      await submit();

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

  it.each([false, true])(
    "requires project access to save even with settings access (revoked: %s)",
    async (revokeBeforeSubmit) => {
      setup();
      await using screen = await render(null);
      permissions.canEditProject = revokeBeforeSubmit;
      permissions.canWriteSettings = true;
      const onSubmit = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      await openEditor(screen, onSubmit);

      permissions.canEditProject = false;
      await submit();
      expect(onSubmit).not.toHaveBeenCalled();

      permissions.canEditProject = true;
      await submit();
      expect(onSubmit).toHaveBeenCalledOnce();
    },
  );

  it("rechecks project access before deleting from an already open confirmation", async () => {
    setup();
    await using screen = await render(null);
    const actions = { onDelete: vi.fn(), onClose: vi.fn() };
    await openEditor(screen, undefined, request, actions);
    await click("Delete");

    permissions.canEditProject = false;
    await click("Delete action");
    expect(actions.onDelete).not.toHaveBeenCalled();
    expect(actions.onClose).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(confirmation()).toBeNull());

    permissions.canEditProject = true;
    await publish();
    await click("Delete");
    await click("Delete action");
    expect(actions.onDelete).toHaveBeenCalledExactlyOnceWith(request.scriptId);
    expect(actions.onClose).toHaveBeenCalledOnce();
  });
});
