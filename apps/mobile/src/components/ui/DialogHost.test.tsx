import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Alert: { alert: vi.fn() },
    KeyboardAvoidingView: Slot,
    Modal: (props: {
      readonly children?: ReactNode;
      readonly visible: boolean;
      readonly onDismiss?: () => void;
      readonly onRequestClose?: () => void;
    }) => (
      <div>
        {props.visible ? props.children : null}
        <button onClick={props.onDismiss}>Dismiss modal</button>
        <button onClick={props.onRequestClose}>Request close</button>
      </div>
    ),
    ScrollView: Slot,
    View: Slot,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock("./AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  AppTextInput: (props: { readonly value: string; readonly onChangeText: (v: string) => void }) => (
    <input value={props.value} onChange={(event) => props.onChangeText(event.target.value)} />
  ),
}));
vi.mock("./Button", () => ({
  Button: (props: { readonly label: string; readonly onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("./GlassSurface", () => ({
  GlassSurface: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import * as Dialog from "./Dialog";
import { DialogHost, DialogSheetHost } from "./DialogHost";

const roots: Root[] = [];

function mountHost(host: () => ReactNode = () => <DialogHost />) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(host()));
  return { root, container };
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
}

function promptRename(onConfirm: (value: string) => void) {
  act(() =>
    Dialog.prompt({
      title: "Rename thread",
      initialValue: "old",
      confirmText: "Rename",
      onConfirm,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("confirms the edited value exactly once after native dismissal", () => {
  const { container } = mountHost();
  const onConfirm = vi.fn();
  promptRename(onConfirm);

  const input = container.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const rename = button(container, "Rename");
  act(() => {
    rename.click();
    rename.click();
  });

  expect(onConfirm).not.toHaveBeenCalled();
  const dismiss = button(container, "Dismiss modal");
  act(() => {
    dismiss.click();
    dismiss.click();
  });
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith("new");
  expect(container.textContent).toBe("");
});

it("presents from a mounted sheet host, then falls back to the root host", () => {
  const app = mountHost();
  const sheet = mountHost(() => <DialogSheetHost />);

  promptRename(vi.fn());
  expect(sheet.container.textContent).toContain("Rename thread");
  expect(app.container.textContent).toBe("");
  act(() => button(sheet.container, "Cancel").click());

  roots.splice(roots.indexOf(sheet.root), 1);
  act(() => sheet.root.unmount());
  promptRename(vi.fn());
  expect(app.container.textContent).toContain("Rename thread");
});

it.each(["Cancel", "Request close"])(
  "waits for dismissal before %s opens another dialog",
  (action) => {
    const { container } = mountHost();
    const onCancel = vi.fn(() =>
      Dialog.prompt({
        title: "Second prompt",
        initialValue: "",
        confirmText: "Save",
        onConfirm: vi.fn(),
      }),
    );
    act(() =>
      Dialog.prompt({
        title: "First prompt",
        initialValue: "",
        confirmText: "Save",
        onConfirm: vi.fn(),
        onCancel,
      }),
    );
    act(() => button(container, action).click());
    expect(onCancel).not.toHaveBeenCalled();
    const dismiss = button(container, "Dismiss modal");
    act(() => {
      dismiss.click();
      dismiss.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Second prompt");
    expect(container.textContent).not.toContain("First prompt");
  },
);
