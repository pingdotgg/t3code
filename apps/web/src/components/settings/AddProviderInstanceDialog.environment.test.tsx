import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const actions = vi.hoisted(() => ({
  update: vi.fn(),
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  update: vi.fn(() => actions.update),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  useUpdateEnvironmentSettings: settingsHooks.update,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return { ...actual, useEnvironmentScope: hasScope, readEnvironmentScope: hasScope };
});

vi.mock("../ui/toast", () => ({ toastManager: { add: actions.toast } }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function renderDialog() {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange: actions.onOpenChange,
  });
}

function button(dialog: unknown, label: string) {
  const element = visitElements(
    dialog,
    (entry) => entry.props.children === label && typeof entry.props.onClick === "function",
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function prepareInstance() {
  let dialog = renderDialog();
  (button(dialog, "Next").props.onClick as () => void)();
  dialog = renderDialog();
  const label = visitElements(dialog, (entry) => entry.props.placeholder === "e.g. Work");
  if (!label) throw new Error("Missing instance label input.");
  (label.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "Work" },
  });
  dialog = renderDialog();
  (button(dialog, "Next").props.onClick as () => void)();
  return renderDialog();
}

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockClear();
    settingsHooks.update.mockClear();
    actions.update.mockReset();
    actions.toast.mockReset();
    actions.onOpenChange.mockReset();
    actions.canManageProviders = true;
  });

  it("reads and writes settings through the supplied environment", () => {
    hooks.beginRender();
    AddProviderInstanceDialog({
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    });

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.update).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("adds an instance with the selected environment's provider grant alone", () => {
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();

    expect(actions.update).toHaveBeenCalledWith({
      providerInstances: { codex_work: { driver: "codex", enabled: true, displayName: "Work" } },
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Provider instance added" }),
    );
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects a queued save after the provider grant is revoked", () => {
    const dialog = prepareInstance();
    const save = button(dialog, "Add instance").props.onClick as () => void;
    actions.canManageProviders = false;
    save();

    expect(actions.update).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(button(renderDialog(), "Add instance").props.disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", () => {
    actions.canManageProviders = false;
    let dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(actions.update).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    dialog = renderDialog();
    expect(button(dialog, "Add instance").props.disabled).toBe(false);
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(actions.update).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
