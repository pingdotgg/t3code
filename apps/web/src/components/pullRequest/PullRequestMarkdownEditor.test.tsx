import { AuthSourceControlWriteScope, EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const permissions = vi.hoisted(() => ({
  allowed: new Set<string>(),
  listeners: new Set<() => void>(),
}));

vi.mock("~/state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const canWrite = (environmentId: string, scope: string) =>
    scope === AuthSourceControlWriteScope && permissions.allowed.has(environmentId);
  return {
    readEnvironmentScope: canWrite,
    useEnvironmentScope: (environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          permissions.listeners.add(listener);
          return () => permissions.listeners.delete(listener);
        },
        () => canWrite(environmentId, scope),
      ),
  };
});
vi.mock("~/lib/utils", () => ({ cn: () => "" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("./PullRequestMarkdown", () => ({ PullRequestMarkdown: "article" }));

import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
let renderer: ReactTestRenderer | undefined;
const onSave = vi.fn<(next: string) => void>();
const onCancel = vi.fn<() => void>();

beforeEach(() => {
  permissions.allowed.clear();
  permissions.listeners.clear();
  renderer = undefined;
  onSave.mockReset();
  onCancel.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openEditor(options?: { value?: string; allowEmpty?: boolean }) {
  await act(() => {
    renderer = create(
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
  });
}

function saveHandler(): () => void {
  return renderer!.root.findByProps({ children: "Save" }).props.onClick;
}

async function grant(allowed: boolean) {
  await act(() => {
    if (allowed) permissions.allowed.add(secondary);
    else permissions.allowed.delete(secondary);
    permissions.listeners.forEach((listener) => listener());
  });
}

it("does not save a secondary environment's description using the primary grant", async () => {
  permissions.allowed.add(primary);
  await openEditor();

  await act(() => saveHandler()());

  expect(onSave).not.toHaveBeenCalled();
});

it("rejects a retained Save callback when the grant changes before React updates", async () => {
  permissions.allowed.add(secondary);
  await openEditor();
  const save = saveHandler();
  permissions.allowed.delete(secondary);

  await act(() => save());

  expect(onSave).not.toHaveBeenCalled();
});

it("keeps an edited draft through revocation and saves it after access returns without remounting", async () => {
  permissions.allowed.add(secondary);
  await openEditor();
  await act(() => {
    renderer!.root.findByType("textarea").props.onChange({
      target: { value: "Keep these unsaved edits" },
    });
  });

  await grant(false);
  await act(() => saveHandler()());
  expect(onSave).not.toHaveBeenCalled();

  await grant(true);
  await act(() => saveHandler()());
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Keep these unsaved edits");
});

it("saves with source-control permission alone", async () => {
  permissions.allowed.add(secondary);
  await openEditor();

  await act(() => saveHandler()());

  expect(onSave).toHaveBeenCalledExactlyOnceWith("Original description");
});

it("allows clearing a description only after a pending grant becomes available", async () => {
  await openEditor({ value: "", allowEmpty: true });
  await act(() => saveHandler()());
  expect(onSave).not.toHaveBeenCalled();

  await grant(true);
  await act(() => saveHandler()());
  expect(onSave).toHaveBeenCalledExactlyOnceWith("");
});

it("keeps cancelling a local edit available without a write grant", async () => {
  await openEditor();

  await act(() => renderer!.root.findByProps({ children: "Cancel" }).props.onClick());

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
});
