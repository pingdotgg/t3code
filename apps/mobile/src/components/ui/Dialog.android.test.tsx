import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

// Every click handler a button was rendered with, so a test can deliver a
// native event that was dispatched against an older render.
const renderedClicks = vi.hoisted(() => [] as Array<() => void>);

vi.mock("@expo/ui/jetpack-compose", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  const Button = (props: { readonly children?: ReactNode; readonly onClick?: () => void }) => {
    if (props.onClick) renderedClicks.push(props.onClick);
    return <button onClick={props.onClick}>{props.children}</button>;
  };
  return {
    AlertDialog: Object.assign(Slot, {
      Title: Slot,
      Text: Slot,
      DismissButton: Slot,
      ConfirmButton: Slot,
    }),
    Button,
    OutlinedButton: Button,
    Column: Slot,
    FlowRow: Slot,
    Icon: () => null,
    OutlinedTextField: Object.assign(Slot, { Label: Slot, Placeholder: Slot }),
    Text: Slot,
    useNativeState: (value: unknown) => ({ get: () => value }),
  };
});
vi.mock("./NativeThemeHost.android", () => ({
  NativeThemeHost: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({}),
}));
vi.mock("../../lib/mobileTheme", () => ({ themeColorWithContrast: () => "#ffffff" }));

import * as Dialog from "./Dialog.android";

const roots: Root[] = [];

function mountHost() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Dialog.Host />));
  return { root, container };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  renderedClicks.length = 0;
  document.body.innerHTML = "";
});

it("keeps presenting dialogs after an older root's Host unmounts", () => {
  // Android activity replacement mounts the new root before the old one stops.
  const previous = mountHost();
  const current = mountHost();
  roots.splice(roots.indexOf(previous.root), 1);
  act(() => previous.root.unmount());

  act(() => Dialog.alert("Saved", undefined, [{ text: "OK" }]));

  expect(current.container.textContent).toContain("Saved");
});

it("presents a dialog requested before any Host mounted", () => {
  Dialog.alert("Could not import shared content", undefined, [{ text: "Dismiss" }]);

  const { container } = mountHost();

  expect(container.textContent).toContain("Could not import shared content");
});

it("keeps a dialog raised while the activity is replaced", () => {
  const previous = mountHost();
  act(() => Dialog.alert("Shared content imported", undefined, [{ text: "OK" }]));
  const current = mountHost();
  roots.splice(roots.indexOf(previous.root), 1);
  act(() => previous.root.unmount());

  expect(current.container.textContent).toContain("Shared content imported");
});

it("ignores a late action from a dialog that a newer one replaced", () => {
  const { container } = mountHost();
  const olderAction = vi.fn();
  act(() => Dialog.alert("Older", undefined, [{ text: "OK", onPress: olderAction }]));
  const olderClick = renderedClicks.at(-1)!;
  act(() => Dialog.alert("Newer", undefined, [{ text: "OK" }]));

  act(() => olderClick());

  expect(olderAction).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Newer");
});
