import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppLockStatus } from "../app-lock/appLock";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    configure: vi.fn<(enabled: boolean, timeoutSeconds: number) => Promise<boolean>>(),
    read: vi.fn<() => Promise<AppLockStatus | null>>(),
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p>{message}</p>,
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button disabled={props.disabled} onClick={() => props.onValueChange(!props.value)}>
      Toggle App Lock
    </button>
  ),
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
const statusAtom = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../app-lock/appLock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-lock/appLock")>();
  return {
    ...actual,
    get appLockStatusAtom() {
      return statusAtom.current;
    },
    configureAppLock: mocks.configure,
    readAppLockStatus: mocks.read,
  };
});

import { SettingsAppLockRouteScreen } from "./SettingsAppLockRouteScreen";

const OFF: AppLockStatus = {
  enabled: false,
  timeoutSeconds: 60,
  available: true,
  biometry: "faceID",
};

let container: HTMLDivElement;
let root: Root;

function render(status: AppLockStatus) {
  statusAtom.current = Atom.make<AppLockStatus | null>(status);
  act(() =>
    root.render(
      <RegistryContext.Provider value={AtomRegistry.make()}>
        <SettingsAppLockRouteScreen />
      </RegistryContext.Provider>,
    ),
  );
}

function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.configure.mockReset();
  mocks.read.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SettingsAppLockRouteScreen", () => {
  it("turns the lock on with the current timeout and then offers the timeouts", async () => {
    mocks.configure.mockResolvedValue(true);
    mocks.read.mockResolvedValue({ ...OFF, enabled: true });
    render(OFF);
    expect(container.textContent).not.toContain("After 5 minutes");

    await act(async () => button("Toggle App Lock").click());

    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith(true, 60);
    expect(button("After 5 minutes")).toBeTruthy();
  });

  it("passes a picked timeout to the native lock", async () => {
    const on = { ...OFF, enabled: true };
    mocks.configure.mockResolvedValue(true);
    mocks.read.mockResolvedValue({ ...on, timeoutSeconds: 900 });
    render(on);

    await act(async () => button("After 15 minutes").click());

    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith(true, 900);
  });

  it("explains a missing passcode instead of turning on", async () => {
    mocks.configure.mockRejectedValue(
      Object.assign(new Error("no passcode"), { code: "ERR_APP_LOCK_UNAVAILABLE" }),
    );
    mocks.read.mockResolvedValue(OFF);
    render(OFF);

    await act(async () => button("Toggle App Lock").click());

    expect(container.textContent).toContain("Set a passcode in iOS Settings to use App Lock.");
    expect(container.textContent).not.toContain("After 5 minutes");
  });

  it("disables the switch while the device has no passcode", () => {
    render({ ...OFF, available: false });

    expect(button("Toggle App Lock").disabled).toBe(true);
    expect(container.textContent).toContain("Set a passcode in iOS Settings to use App Lock.");
  });
});
