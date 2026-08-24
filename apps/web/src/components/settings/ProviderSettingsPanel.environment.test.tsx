import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  uninstallAcpRegistryManagedBinary: Symbol("uninstallAcpRegistryManagedBinary"),
  acceptAcpRegistryUrlAuth: Symbol("acceptAcpRegistryUrlAuth"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  mutationEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
    uninstallAcpRegistryManagedBinary: atoms.uninstallAcpRegistryManagedBinary,
    acceptAcpRegistryUrlAuth: atoms.acceptAcpRegistryUrlAuth,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders
      ? commands.refresh
      : atom === atoms.uninstallAcpRegistryManagedBinary
        ? commands.uninstall
        : atom === atoms.acceptAcpRegistryUrlAuth
          ? commands.acceptUrlAuth
          : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    settingsState.mutationEnvironmentIds.push(environmentId);
    return settingsState.mutateProviderInstance;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  }) as ReactElement<Record<string, unknown>>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.mutationEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.mutateProviderInstance
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: {} });
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.uninstall.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    commands.acceptUrlAuth
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { accepted: true } });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.mutationEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Refresh provider status",
    );
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({ environmentId, input: {} });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("renders the provider layout inert with a limited-permissions notice when read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();
    const providerCard = visitElements(panel, (element) => element.props.instanceId === codexId);
    expect(providerCard).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Add provider instance"),
    ).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Refresh provider status"),
    ).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    const panel = renderPanel();
    const customCard = visitElements(panel, (element) => element.props.instanceId === customId);
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: customId,
    });

    settingsState.mutateProviderInstance.mockClear();
    const defaultCard = visitElements(panel, (element) => element.props.instanceId === codexId);
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    const [resetMutation, resetPatch] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: codexId });
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === customId);
    const next = {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
    };
    (card?.props.onUpdate as ((instance: typeof next) => void) | undefined)?.(next);
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith(
      { operation: "upsert", instanceId: customId, instance: next },
      {},
    );
  });

  it("lets the server decide managed ACP cleanup after an atomic delete", async () => {
    const firstId = ProviderInstanceId.make("acpRegistry_kilo_one");
    const secondId = ProviderInstanceId.make("acpRegistry_kilo_two");
    const registryInstance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: { agentId: "kilo" },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [firstId]: registryInstance,
        [secondId]: registryInstance,
      },
    };
    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === firstId);
    (card?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "remove",
      instanceId: firstId,
    });
    expect(commands.uninstall).toHaveBeenCalledWith({
      environmentId,
      input: { agentId: "kilo" },
    });
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ];

    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === instanceId);
    (card?.props.onAcceptUrlAuth as ((candidate: typeof action) => void) | undefined)?.(action);
    await flushPromises();

    expect(commands.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
