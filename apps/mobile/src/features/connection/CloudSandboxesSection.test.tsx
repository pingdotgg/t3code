import { Atom, AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  ManagedCloudSandboxResourceId,
  SandboxProfileId,
  type CloudSandboxProfileStatus,
  type ManagedCloudSandboxResource,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  mocks: {
    profiles: null as null | { readonly profiles: ReadonlyArray<unknown> },
    sandboxes: null as null | ReadonlyArray<unknown>,
    confirm: vi.fn<(request: { readonly onConfirm: () => void }) => void>(),
    deleteProfile: vi.fn(),
    deleteSandbox: vi.fn(),
    connect: vi.fn(),
    removeEnvironment: vi.fn(),
    registered: new Map<string, unknown>(),
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: ({ label, description }: { label: string; description?: string }) => (
    <div>
      {label}
      {description}
    </div>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("./ConnectionFormField", () => ({ ConnectionFormField: () => null }));
vi.mock("../../connection/onboarding", () => ({ connectCloudSandboxEnvironment: mocks.connect }));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { remove: mocks.removeEnvironment },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: mocks.registered }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    const data =
      typeof query === "object" && query !== null && "input" in query
        ? mocks.profiles
        : mocks.sandboxes;
    return { data, refresh: vi.fn() };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/cloudSandboxes", () => ({
  // A tagged input marks the profile list query; the sandbox list is tagged by its family.
  sandboxProfilesList: (input: unknown) => input,
  sandboxProfilesSave: Object.assign(vi.fn(), { permissionAtom: () => Atom.make(true) }),
  sandboxProfilesDelete: Object.assign(mocks.deleteProfile, {
    permissionAtom: () => Atom.make(true),
  }),
  managedSandboxesAtom: (environmentId: unknown) => ({ sandboxesFor: environmentId }),
  cloudSandboxOperation: Object.assign(vi.fn(), { permissionAtom: () => Atom.make(true) }),
  deleteManagedSandbox: mocks.deleteSandbox,
}));

import { CloudSandboxesSection } from "./CloudSandboxesSection";

const environmentId = EnvironmentId.make("environment-1");
let root: Root;
let container: HTMLDivElement;

const profileStatus: CloudSandboxProfileStatus = {
  profile: {
    profileId: SandboxProfileId.make("boat-main"),
    name: "boat.dev",
    driverKind: "boat",
    apiKeySet: true,
    defaultSize: "default",
    autoStopMinutes: 60,
    template: null,
    monthlyBudgetUsd: null,
    maxConcurrentSandboxes: 3,
  },
  spend: null,
};

const sandbox: ManagedCloudSandboxResource = {
  resourceId: ManagedCloudSandboxResourceId.make("resource-1"),
  controllerEnvironmentId: environmentId,
  driverKind: "boat",
  profileId: SandboxProfileId.make("boat-main"),
  sandboxId: "sbx-1",
  parentResourceId: null,
  phase: "connected",
  environmentId: null,
  label: "Feature sandbox",
  recordingIds: [],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.profiles = null;
  mocks.sandboxes = null;
  mocks.confirm.mockReset();
  mocks.deleteProfile.mockReset();
  mocks.deleteSandbox.mockReset();
  mocks.deleteSandbox.mockResolvedValue(AsyncResult.success(undefined));
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValue(AsyncResult.success(EnvironmentId.make("child")));
  mocks.removeEnvironment.mockReset();
  mocks.removeEnvironment.mockResolvedValue(AsyncResult.success(undefined));
  mocks.registered.clear();
});

afterEach(() => {
  act(() => root.unmount());
});

it("renders nothing when the environment has no profiles and no sandboxes", () => {
  mocks.profiles = { profiles: [] };
  mocks.sandboxes = [];
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));
  expect(container.innerHTML).toBe("");
});

it("asks before removing a profile and removes it only once confirmed", async () => {
  mocks.profiles = { profiles: [profileStatus] };
  mocks.sandboxes = [];
  mocks.deleteProfile.mockResolvedValue(AsyncResult.success({ profileId: "boat-main" }));
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));

  const remove = [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove");
  act(() => remove?.click());

  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Removes the stored API key. Sandboxes from this profile must be deleted first.",
      destructive: true,
    }),
  );
  expect(mocks.deleteProfile).not.toHaveBeenCalled();

  const request = mocks.confirm.mock.calls[0]?.[0];
  await act(async () => request?.onConfirm());
  expect(mocks.deleteProfile).toHaveBeenCalledWith({
    environmentId,
    input: { profileId: "boat-main" },
  });
});

it("asks before deleting a sandbox and deletes it only once confirmed", async () => {
  mocks.profiles = { profiles: [] };
  mocks.sandboxes = [sandbox];
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));

  expect(container.textContent).toContain("Running · sbx-1");
  const destroy = [...container.querySelectorAll("button")].find((b) => b.textContent === "Delete");
  act(() => destroy?.click());

  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Deletes this sandbox and its disk. Unsaved work in it is lost.",
      destructive: true,
    }),
  );
  expect(mocks.deleteSandbox).not.toHaveBeenCalled();

  const request = mocks.confirm.mock.calls[0]?.[0];
  await act(async () => request?.onConfirm());
  expect(mocks.deleteSandbox).toHaveBeenCalledWith({
    controllerEnvironmentId: environmentId,
    resourceId: "resource-1",
  });
});

it("removes the environment of a registered sandbox once it is deleted", async () => {
  const child = EnvironmentId.make("child");
  mocks.profiles = { profiles: [] };
  mocks.sandboxes = [{ ...sandbox, environmentId: child }];
  mocks.registered.set(child, {});
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));
  const destroy = [...container.querySelectorAll("button")].find((b) => b.textContent === "Delete");
  act(() => destroy?.click());

  const request = mocks.confirm.mock.calls[0]?.[0];
  await act(async () => request?.onConfirm());

  expect(mocks.deleteSandbox).toHaveBeenCalledWith({
    controllerEnvironmentId: environmentId,
    resourceId: "resource-1",
  });
  expect(mocks.removeEnvironment).toHaveBeenCalledExactlyOnceWith(child);
});

it("opens a running sandbox as an environment, and offers nothing once it is registered", async () => {
  mocks.profiles = { profiles: [] };
  mocks.sandboxes = [{ ...sandbox, environmentId: EnvironmentId.make("child") }];
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));
  const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "Open");
  await act(async () => open?.click());
  expect(mocks.connect).toHaveBeenCalledWith({
    controllerEnvironmentId: environmentId,
    resourceId: "resource-1",
    label: "Feature sandbox",
  });

  mocks.registered.set("child", {});
  act(() => root.render(<CloudSandboxesSection environmentId={environmentId} />));
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Open")).toBe(
    false,
  );
});
