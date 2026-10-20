import { act, render, type Screen } from "../../../test/render";
import { AuthSourceControlWriteScope, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const permissions = vi.hoisted(() => ({
  allowed: new Set<string>(),
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const canWrite = (environmentId: string | null, scope: string) =>
    scope === AuthSourceControlWriteScope && permissions.allowed.has(environmentId ?? "");
  return {
    ...(await original()),
    readEnvironmentScope: canWrite,
    useEnvironmentScope: (environmentId, scope) =>
      useSyncExternalStore(
        (listener) => {
          permissions.listeners.add(listener);
          return () => permissions.listeners.delete(listener);
        },
        () => canWrite(environmentId, scope),
      ),
  };
});

import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const onSave = vi.fn<(next: string) => void>();
const onCancel = vi.fn<() => void>();

function setup() {
  permissions.allowed.clear();
  permissions.listeners.clear();
  onSave.mockReset();
  onCancel.mockReset();
}

async function openEditor(options?: { value?: string; allowEmpty?: boolean }) {
  return render(
    <PullRequestMarkdownEditor
      value={options?.value ?? "Original description"}
      cwd="/repo"
      environmentId={secondary}
      label="Pull request description"
      saving={false}
      allowEmpty={options?.allowEmpty ?? false}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
}

function button(screen: Screen, label: string) {
  const match = [...screen.container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

const clickSave = (screen: Screen) => act(async () => button(screen, "Save").click());

async function grant(allowed: boolean) {
  await act(async () => {
    if (allowed) permissions.allowed.add(secondary);
    else permissions.allowed.delete(secondary);
    permissions.listeners.forEach((listener) => listener());
  });
}

it("does not save a secondary environment's description using the primary grant", async () => {
  setup();
  permissions.allowed.add(primary);
  await using screen = await openEditor();

  expect(button(screen, "Save").disabled).toBe(true);
  await clickSave(screen);

  expect(onSave).not.toHaveBeenCalled();
});

it("rejects a Save click when the grant changes before React updates", async () => {
  setup();
  permissions.allowed.add(secondary);
  await using screen = await openEditor();
  permissions.allowed.delete(secondary);

  expect(button(screen, "Save").disabled).toBe(false);
  await clickSave(screen);

  expect(onSave).not.toHaveBeenCalled();
});

it("keeps an edited draft through revocation and saves it after access returns without remounting", async () => {
  setup();
  permissions.allowed.add(secondary);
  await using screen = await openEditor();
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Keep these unsaved edits");

  await grant(false);
  expect(button(screen, "Save").disabled).toBe(true);
  expect(screen.container.querySelector("textarea")).toBe(textarea);

  await grant(true);
  await clickSave(screen);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Keep these unsaved edits");
});

it("saves with source-control permission alone, from the button or Cmd/Ctrl+Enter", async () => {
  setup();
  permissions.allowed.add(secondary);
  await using screen = await openEditor();

  await clickSave(screen);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Original description");

  screen.container.querySelector("textarea")!.focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("allows clearing a description only after a pending grant becomes available", async () => {
  setup();
  await using screen = await openEditor({ value: "", allowEmpty: true });
  await clickSave(screen);
  expect(onSave).not.toHaveBeenCalled();

  await grant(true);
  await clickSave(screen);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("");
});

it("keeps cancelling a local edit available without a write grant", async () => {
  setup();
  await using screen = await openEditor();

  await act(async () => button(screen, "Cancel").click());
  screen.container.querySelector("textarea")!.focus();
  await userEvent.keyboard("{Escape}");

  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onSave).not.toHaveBeenCalled();
});
