import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  // The real row reads write permission and overrides from live environment state.
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
// Its own data flows are covered by its suite; this one is about the panel.
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
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
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
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

let root: Root;
let container: HTMLDivElement;

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

async function render(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <div className="@container/providers">
          <EnvironmentProviderSettings
            environmentId={environmentId}
            environmentLabel="Remote device"
            {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
            {...(options?.targetInstanceId === undefined
              ? {}
              : { targetInstanceId: options.targetInstanceId })}
          />
        </div>
      </RegistryContext.Provider>,
    ),
  );
}

const button = (name: string) => page.getByRole("button", { name, exact: true });
const refreshButton = () => page.getByRole("button", { name: /^Refresh provider status/ });
// The section header and the end of the provider list both offer Add provider.
const addProvider = () => page.getByRole("button", { name: "Add provider" }).first();
const select = (name: string) => button(`Select ${name}`);
const deleteButton = (id: string) => button(`Delete instance ${id}`);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("EnvironmentProviderSettings routing", () => {
  it("shows Codex and Claude while hiding untouched disabled provider slots", async () => {
    await render();
    await expect.element(select("Codex")).toBeVisible();
    await expect.element(select("Claude")).toBeVisible();
    for (const label of ["Cursor", "Grok", "Pi", "OpenCode", "Antigravity"]) {
      await expect.element(select(label)).not.toBeInTheDocument();
    }
  });

  it("keeps explicitly configured providers visible when disabled", async () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          enabled: false,
        },
      },
    };
    await render();
    await expect.element(select("Grok")).toBeVisible();
  });

  it("keeps legacy provider configuration visible when disabled", async () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          enabled: false,
          config: { binaryPath: "/custom/grok" },
        },
      },
    };
    await render();
    await expect.element(select("Grok")).toBeVisible();
  });

  it("reads and writes settings on the selected environment", async () => {
    await render();
    await expect.element(select("Codex")).toBeVisible();
    expect(new Set(state.readEnvironmentIds)).toEqual(new Set([environmentId]));
    expect(new Set(state.updateEnvironmentIds)).toEqual(new Set([environmentId]));
    expect(new Set(state.mutationEnvironmentIds)).toEqual(new Set([environmentId]));
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    await setProviders([provider()]);
    await render();

    await userEvent.click(refreshButton());
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

    await userEvent.click(page.getByRole("button", { name: /view details/ }).last());
    await userEvent.click(button("Update now"));
    expect(state.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("opens the requested provider instance instead of the first provider", async () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await setProviders([provider()]);
    await render({ targetInstanceId: customId });
    await expect.element(deleteButton(customId)).toBeVisible();
  });

  it("saves model favorites and visibility on the selected environment", async () => {
    await setProviders([provider()]);
    await render();

    await userEvent.click(button("Add Chosen to favorites"));
    expect(state.toggleFavorite).toHaveBeenCalledExactlyOnceWith(codexId, "chosen");

    await userEvent.click(page.getByRole("switch", { name: "Show Chosen in the model picker" }));
    expect(state.updateModelPreferences).toHaveBeenCalledExactlyOnceWith({
      setModelsHidden: [{ provider: codexId, model: "chosen", hidden: true }],
    });
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", async () => {
    await setProviders([provider()]);
    await render({ targetInstanceId: customId });
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", async () => {
    state.canWriteSettings = false;
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await setProviders([provider()]);
    await render({ readOnly: true });

    await expect.element(page.getByRole("heading", { name: "Limited permissions" })).toBeVisible();
    await userEvent.click(select("Work"));
    await expect.element(deleteButton(customId)).toBeInTheDocument();
    expect(container.querySelector("[inert]")).not.toBeNull();
    await expect.element(refreshButton()).toBeVisible();
    await expect.element(addProvider()).not.toBeInTheDocument();
  });

  it("keeps the editable layout interactive when not read only", async () => {
    await setProviders([provider()]);
    await render();
    await expect.element(page.getByText("Limited permissions")).not.toBeInTheDocument();
    await expect.element(refreshButton()).toBeVisible();
    await expect.element(addProvider()).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Enable Codex" }).first()).toBeEnabled();
  });

  it("removes an open add-instance dialog when the provider grant is revoked", async () => {
    await render();
    await userEvent.click(addProvider());
    await expect.element(page.getByRole("dialog")).toBeVisible();

    state.canManageProviders = false;
    await render({ readOnly: true });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps Advanced visible when search targets the provider health interval", async () => {
    await render();
    await expect.element(page.getByText("Advanced", { exact: true })).toBeVisible();
    expect(container.querySelector("#provider-health-check-interval")).not.toBeNull();

    state.searchTargetId = "provider-health-check-interval";
    await render();
    await expect.element(page.getByText("Advanced", { exact: true })).toBeVisible();
    expect(container.querySelector("#provider-health-check-interval")).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", async () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    await render();
    await userEvent.click(select("Work"));
    await userEvent.click(deleteButton(customId));
    expect(state.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: customId,
    });

    state.mutateProviderInstance.mockClear();
    await userEvent.click(select("Codex"));
    await userEvent.click(button("Reset Codex provider settings to default"));
    const [resetMutation, resetPatch] = state.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: codexId });
    expect(resetPatch ?? {}).toEqual({});
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await render();
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("lets the server decide managed ACP cleanup after an atomic delete", async () => {
    const firstId = ProviderInstanceId.make("acpRegistry_kilo_one");
    const secondId = ProviderInstanceId.make("acpRegistry_kilo_two");
    const registryInstance = (displayName: string) => ({
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      displayName,
      config: { agentId: "kilo" },
    });
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [firstId]: registryInstance("Kilo one"),
        [secondId]: registryInstance("Kilo two"),
      },
    };
    await render();
    await userEvent.click(select("Kilo one"));
    await userEvent.click(deleteButton(firstId));

    expect(state.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "remove",
      instanceId: firstId,
    });
    await vi.waitFor(() =>
      expect(state.uninstall).toHaveBeenCalledWith({ environmentId, input: { agentId: "kilo" } }),
    );
  });

  it("keeps the signed-in ACP account visible when login methods are no longer advertised", async () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "devin" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "authenticated", canLogout: false },
        setup: { canAuthenticate: false, canInstall: false },
      },
    ]);
    await render({ targetInstanceId: instanceId });
    await expect.element(page.getByRole("heading", { name: "Account" })).toBeVisible();
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await render({ targetInstanceId: instanceId });
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
