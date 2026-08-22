import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { markConnectOnboardingAuthPending } from "../../cloud/connectOnboarding";

const authState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  userId: "user-after-desktop-auth" as string | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@clerk/react", () => ({
  useAuth: () => authState,
}));

vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => true,
}));

vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: {
      data: null,
      isPending: false,
      target: { environmentId: "local" },
    },
    operationError: null,
    reconcileCloudState: vi.fn(),
  }),
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null }),
}));

vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initialValue: unknown) => [initialValue, vi.fn()],
}));

import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

const sessionValues = new Map<string, string>();
const sessionStorage = {
  getItem: vi.fn((key: string) => sessionValues.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => sessionValues.set(key, value)),
  removeItem: vi.fn((key: string) => sessionValues.delete(key)),
};

function renderConfiguredDialog() {
  const wrapper = ConnectOnboardingDialog() as ReactElement;
  const ConfiguredDialog = wrapper.type as () => ReactElement<{ open: boolean }>;

  hooks.beginRender();
  return ConfiguredDialog();
}

describe("ConnectOnboardingDialog", () => {
  beforeEach(() => {
    hooks.reset();
    sessionValues.clear();
    authState.isLoaded = true;
    authState.isSignedIn = true;
    authState.userId = "user-after-desktop-auth";
    vi.stubGlobal("window", { desktopBridge: {}, sessionStorage });
  });

  it("opens after an in-place desktop sign-in", () => {
    authState.isSignedIn = false;
    authState.userId = null;
    renderConfiguredDialog();

    markConnectOnboardingAuthPending();
    authState.isSignedIn = true;
    authState.userId = "user-after-desktop-auth";
    renderConfiguredDialog();
    renderConfiguredDialog();
    const dialog = renderConfiguredDialog();

    expect(dialog.props.open).toBe(true);
  });

  it("opens when the desktop renderer returns from auth already signed in", () => {
    markConnectOnboardingAuthPending();
    renderConfiguredDialog();
    renderConfiguredDialog();
    const dialog = renderConfiguredDialog();

    expect(dialog.props.open).toBe(true);
  });

  it("stays closed on a normal desktop launch with a restored session", () => {
    renderConfiguredDialog();
    renderConfiguredDialog();
    const dialog = renderConfiguredDialog();

    expect(dialog.props.open).toBe(false);
  });
});
