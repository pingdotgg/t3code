import type { ReactElement } from "react";
import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "../../state/environments";
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
  deleteSettings: Symbol("deleteSettings"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  deleteSettings: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
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
    updateSettings: atoms.deleteSettings,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders
      ? commands.refresh
      : atom === atoms.deleteSettings
        ? commands.deleteSettings
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
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings, ProviderSettingsPanel } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

const primaryId = EnvironmentId.make("primary");
const environments: EnvironmentPresentation[] = [primaryId, environmentId].map((id) => ({
  environmentId: id,
  label: id,
  displayUrl: null,
  relayManaged: id !== primaryId,
  entry: {
    target:
      id === primaryId
        ? new PrimaryConnectionTarget({
            environmentId: id,
            label: id,
            httpBaseUrl: "http://localhost",
            wsBaseUrl: "ws://localhost",
          })
        : new RelayConnectionTarget({ environmentId: id, label: id }),
    profile: Option.none(),
  },
  connection: { phase: "connected", error: null, traceId: null },
  serverConfig: null,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments, isReady: true }),
  usePrimaryEnvironmentId: () => primaryId,
}));

function renderPage() {
  hooks.beginRender();
  const content = visitElements(
    ProviderSettingsPanel({}),
    (element) =>
      typeof element.type === "function" && element.type.name === "ProviderSettingsPanelContent",
  );
  if (!content) throw new Error("Provider page content missing");
  const render = content.type as (
    props: Record<string, unknown>,
  ) => ReactElement<Record<string, unknown>>;
  return render(content.props);
}

function selectedEnvironment(page: ReturnType<typeof renderPage>) {
  const selected = visitElements(page, (element) => element.props.environment !== undefined);
  if (!selected) throw new Error("Selected environment missing");
  return selected as ReactElement<{
    environment: EnvironmentPresentation;
    view: Parameters<typeof EnvironmentProviderSettings>[0]["view"];
    deviceTabs: ReactElement;
  }>;
}

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
  readonly view?: "accounts" | "usage" | "health";
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    view: { value: options?.view ?? "accounts", onValueChange: vi.fn() },
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
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
    settingsState.updateSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    commands.deleteSettings.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

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

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("groups an instance occupying another driver's default ID only under its actual driver", () => {
    const instanceId = ProviderInstanceId.make("opencode");
    const driver = ProviderDriverKind.make("cursor");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [instanceId]: { driver, enabled: true } },
    };
    atoms.providers = [
      { ...provider(), instanceId: ProviderInstanceId.make("cursor"), driver },
      { ...provider(), instanceId, driver },
    ];

    const panel = renderPanel();
    let matchingRows = 0;
    visitElements(panel, (element) => {
      if (element.props.mode === "list" && element.props.instanceId === instanceId) {
        matchingRows += 1;
      }
      return false;
    });
    expect(matchingRows).toBe(1);
    const cursorGroup = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Cursor accounts",
    );
    const row = visitElements(
      cursorGroup,
      (element) => element.props.mode === "list" && element.props.instanceId === instanceId,
    );
    expect(row).not.toBeNull();
  });

  it("keeps unknown driver accounts selectable without offering an unsupported creation form", () => {
    const instanceId = ProviderInstanceId.make("fork_work");
    const driver = ProviderDriverKind.make("fork-driver");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [instanceId]: { driver, enabled: true } },
    };
    const panel = renderPanel();
    const group = visitElements(
      panel,
      (element) => element.props["aria-label"] === "fork-driver accounts",
    );
    expect(group).not.toBeNull();
    expect(
      visitElements(group, (element) => element.props["aria-label"] === "Add fork-driver account"),
    ).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Add Codex account"),
    ).not.toBeNull();

    const row = visitElements(group, (element) => element.props.instanceId === instanceId);
    (row?.props.onSelect as (() => void) | undefined)?.();
    const editor = visitElements(renderPanel(), (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(instanceId);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();

    panel = renderPanel({ readOnly: true, view: "health" });
    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
  });

  it.each([
    ["provider-health-check-interval", "health"],
    ["usage-providers", "usage"],
  ])("keeps the destination selected after a search jump to %s", (targetId, view) => {
    renderPage();
    settingsSearchState.targetId = targetId;
    // The hook harness needs an explicit render for React's render-time state adjustment.
    renderPage();
    expect(selectedEnvironment(renderPage()).props.view.value).toBe(view);

    settingsSearchState.targetId = null;
    renderPage();
    expect(selectedEnvironment(renderPage()).props.view.value).toBe(view);
  });

  it.each(["usage", "health"] as const)("keeps %s selected when switching devices", (view) => {
    selectedEnvironment(renderPage()).props.view.onValueChange(view);
    const before = selectedEnvironment(renderPage());
    const devices = visitElements(
      before.props.deviceTabs,
      (element) => element.props["aria-label"] === "Devices",
    );
    if (!devices) throw new Error("Device selector missing");
    (devices.props.onValueChange as (ids: EnvironmentId[]) => void)([environmentId]);
    const after = selectedEnvironment(renderPage());
    expect(before.props.environment.environmentId).toBe(primaryId);
    expect(after.props.environment.environmentId).toBe(environmentId);
    expect(after.key).not.toBe(before.key);
    expect(after.props.view.value).toBe(view);
  });

  it.each([
    ["opencode", "fork-driver"],
    ["opencode", "cursor"],
    ["fork-driver", "fork-driver"],
  ])("can remove custom %s accounts with the %s driver", async (rawId, rawDriver) => {
    const instanceId = ProviderInstanceId.make(rawId);
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make(rawDriver), enabled: true },
      },
    };
    const panel = renderPanel({ targetInstanceId: instanceId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    if (!editor) throw new Error("Account editor missing");
    await (editor.props.onDelete as () => Promise<void>)();
    expect(commands.deleteSettings).toHaveBeenCalledWith({
      environmentId,
      input: { patch: { providerInstances: {} } },
    });
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
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    await (customCard?.props.onDelete as (() => Promise<void>) | undefined)?.();

    expect(commands.deleteSettings).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            [codexId]: settingsState.value.providerInstances?.[codexId],
          },
        },
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });
});
