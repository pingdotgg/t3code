import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
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
  mutate: vi.fn(),
  useMutation: vi.fn(),
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

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation,
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
const preparedAgent: AcpRegistrySearchAgent = {
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
};

function render(onOpenChange = vi.fn()) {
  hooks.beginRender();
  return AddProviderInstanceDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    onOpenChange,
  });
}

function findByChildren(tree: ReturnType<typeof render>, children: string) {
  const result = visitElements(tree, (element) => element.props.children === children);
  expect(result).not.toBeNull();
  return result!;
}

async function selectPreparedAcp() {
  const searchStep = render();
  const search = visitElements(
    searchStep,
    (element) =>
      typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
  );
  expect(search).not.toBeNull();
  (search?.props.onPrepared as ((agent: AcpRegistrySearchAgent) => void) | undefined)?.(
    preparedAgent,
  );
}

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
    actions.canManageProviders = true;
    actions.toast.mockReset();
    actions.onOpenChange.mockReset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
  });

  it("creates a provider with its default identity without typing", async () => {
    let tree = render();
    const group = visitElements(
      tree,
      (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
    );
    (group!.props.onValueChange as (value: string) => void)("grok");
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: {
        codex_2: { driver: "codex", enabled: false },
      },
    });
    let tree = render();
    // Codex offers ChatGPT sign-in first; manual setup keeps the existing CLI flow.
    (findByChildren(tree, "Configure manually").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
  });

  it("reads and writes settings through the supplied environment", () => {
    render();

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    const onOpenChange = vi.fn();
    let resolveMutation!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    settingsHooks.mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    await selectPreparedAcp();

    const identityStep = render(onOpenChange);
    expect(
      visitElements(identityStep, (element) => {
        const content = JSON.stringify(element.props.children);
        return content?.includes("4.2.0") === true && content.includes("binary");
      }),
    ).not.toBeNull();
    (
      findByChildren(identityStep, "Continue to sign-in").props.onClick as (() => void) | undefined
    )?.();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        displayName: "Kilo Code",
        config: {
          agentId: "kilo",
          distribution: "auto",
          registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
        },
      },
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveMutation({ _tag: "Success", value: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(onOpenChange).not.toHaveBeenCalled();
    const signInStep = render(onOpenChange);
    const authentication = visitElements(
      signInStep,
      (element) =>
        typeof element.type === "function" &&
        element.type.name === "ProviderWizardAuthenticationStep",
    );
    expect(authentication?.props.instanceId).toBe("acpRegistry_kilo_code");
    expect(authentication?.props.environmentId).toBe(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    (authentication!.props.onFinish as () => void)();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    let tree = render();
    const search = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
    );
    (search!.props.onManualConfiguration as () => void)();
    tree = render();
    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-acpRegistry-manual",
    );
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      agentId: "devin",
    });
    tree = render();
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render();
    (findByChildren(tree, "Continue to sign-in").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    tree = render();
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderWizardAuthenticationStep",
      ),
    ).not.toBeNull();
  });

  it("creates a local command in the selected environment without a sign-in step", async () => {
    const onOpenChange = vi.fn();
    let tree = render(onOpenChange);
    const search = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "AcpRegistrySearchStep",
    );
    (search!.props.onLocalConfiguration as () => void)();
    tree = render(onOpenChange);
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render(onOpenChange);
    expect(findByChildren(tree, "Executable is required.")).not.toBeNull();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    const configuration = visitElements(
      tree,
      (element) => element.props.idPrefix === "add-provider-acpRegistry-manual",
    );
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    (configuration!.props.onChange as (value: Record<string, unknown>) => void)({
      source: "local",
      commandPath: "dsh",
      commandArgs,
    });
    const environmentEditor = visitElements(
      tree,
      (element) =>
        typeof element.type === "function" && element.type.name === "ProviderEnvironmentSection",
    );
    const environment = [{ name: "DSH_PROFILE", value: "work", sensitive: false }];
    (environmentEditor!.props.onChange as (value: typeof environment) => void)(environment);
    tree = render(onOpenChange);
    (findByChildren(tree, "Next").props.onClick as () => void)();
    tree = render(onOpenChange);
    const label = visitElements(tree, (element) => element.props.id === "add-provider-label");
    (label!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Deepseek Harness" },
    });
    tree = render(onOpenChange);
    (findByChildren(tree, "Add instance").props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment,
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    tree = render(onOpenChange);
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderWizardAuthenticationStep",
      ),
    ).toBeNull();
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    const onOpenChange = vi.fn();
    await selectPreparedAcp();

    const identityStep = render(onOpenChange);
    (
      findByChildren(identityStep, "Continue to sign-in").props.onClick as (() => void) | undefined
    )?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("adds an instance with the selected environment's provider grant alone", () => {
    const dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
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

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(button(renderDialog(), "Add instance").props.disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", () => {
    actions.canManageProviders = false;
    let dialog = prepareInstance();
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    dialog = renderDialog();
    expect(button(dialog, "Add instance").props.disabled).toBe(false);
    (button(dialog, "Add instance").props.onClick as () => void)();
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
