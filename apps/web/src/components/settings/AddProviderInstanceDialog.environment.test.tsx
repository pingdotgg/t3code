import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

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
  const initial = render();
  const driverGroup = visitElements(
    initial,
    (element) => element.props["aria-labelledby"] === "add-instance-driver-label",
  );
  (driverGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("acpRegistry");

  const driverStep = render();
  (findByChildren(driverStep, "Next").props.onClick as (() => void) | undefined)?.();

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

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockClear();
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
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
    (findByChildren(identityStep, "Add instance").props.onClick as (() => void) | undefined)?.();
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
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    const onOpenChange = vi.fn();
    await selectPreparedAcp();

    const identityStep = render(onOpenChange);
    (findByChildren(identityStep, "Add instance").props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
