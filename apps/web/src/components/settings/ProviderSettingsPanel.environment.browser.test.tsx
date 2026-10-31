import * as Cause from "effect/Cause";
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import type { Screen } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  providerAuthQuery: null as unknown,
  providerAuth: null as ProviderAuthState | null,
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
  const providerAuth = Atom.make(null);
  state.providerAuthQuery = providerAuth;
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
      providerAuthState: (() => providerAuth) as never,
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
  useEnvironmentQuery: ((query: unknown) => ({
    data: query === state.providerAuthQuery ? state.providerAuth : null,
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

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
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
    </RegistryContext.Provider>
  );
}

// The section header and the end of the provider list both offer Add provider.

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.providerAuth = null;
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
}

async function commitInstanceField(
  screen: Screen,
  field: "badge-label" | "display-name",
  value: string,
) {
  const input = screen.container.querySelector<HTMLInputElement>(
    `#provider-instance-${codexId}-${field}`,
  );
  expect(input).not.toBeNull();
  await userEvent.fill(input!, value);
  await act(async () => input!.blur());
}

async function chooseInstanceIcon(label: string) {
  await userEvent.click(page.getByRole("combobox", { name: "Icon for Codex" }));
  await userEvent.click(page.getByRole("option", { name: label, exact: true }));
}

const savedInstance = (call: number) => {
  const [mutation] = state.mutateProviderInstance.mock.calls[call] ?? [];
  expect(mutation).toBeDefined();
  return (mutation as { instance: ProviderInstanceConfig }).instance;
};

function holdFirstSave() {
  let finish!: () => void;
  state.mutateProviderInstance.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(AsyncResult.success({}));
      }),
  );
  return () => act(async () => finish());
}

describe("EnvironmentProviderSettings routing", () => {
  it("keeps a badge label being saved when an icon is picked", async () => {
    await setup();
    const finish = holdFirstSave();
    await using screen = await render(panel());
    await commitInstanceField(screen, "badge-label", "PX");
    await chooseInstanceIcon("Claude");
    await finish();
    expect(savedInstance(1)).toMatchObject({ badgeLabel: "PX", icon: "claudeAgent" });
  });

  it("keeps another client's unedited field while a local change is saving", async () => {
    await setup();
    const finish = holdFirstSave();
    await using screen = await render(panel());
    await commitInstanceField(screen, "badge-label", "PX");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [codexId]: { driver: ProviderDriverKind.make("codex"), icon: "grok" } },
    };
    await screen.rerender(panel());
    await commitInstanceField(screen, "display-name", "Work");
    await finish();
    expect(savedInstance(1)).toMatchObject({ icon: "grok", badgeLabel: "PX", displayName: "Work" });
  });

  it("keeps a saved edit across a rerender before the server echoes it", async () => {
    await setup();
    await using screen = await render(panel());
    await commitInstanceField(screen, "badge-label", "PX");
    await screen.rerender(panel());
    await chooseInstanceIcon("Claude");
    expect(savedInstance(1)).toMatchObject({ badgeLabel: "PX", icon: "claudeAgent" });
  });

  it("keeps a clear when an older save's echo arrives before the next edit", async () => {
    await setup();
    await using screen = await render(panel());
    await commitInstanceField(screen, "badge-label", "PX");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), badgeLabel: "PX" },
      },
    };
    await screen.rerender(panel());
    await commitInstanceField(screen, "badge-label", "");
    await chooseInstanceIcon("Claude");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), badgeLabel: "PX" },
      },
    };
    await screen.rerender(panel());
    await commitInstanceField(screen, "display-name", "Work");
    expect(savedInstance(3)).toMatchObject({ icon: "claudeAgent", displayName: "Work" });
    expect(savedInstance(3)).not.toHaveProperty("badgeLabel");
  });

  it("starts an edit immediately after a reset from defaults", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), badgeLabel: "OLD" },
      },
    };
    await using screen = await render(panel());
    await commitInstanceField(screen, "badge-label", "PX");
    await userEvent.click(
      page.getByRole("button", { name: "Reset Codex provider settings to default", exact: true }),
    );
    await chooseInstanceIcon("Claude");
    expect(savedInstance(2)).toEqual({
      driver: ProviderDriverKind.make("codex"),
      icon: "claudeAgent",
    });
  });

  it.each([false, true])(
    "starts the next edit from server state after a save fails (overlap: %s)",
    async (overlap) => {
      await setup();
      const finish = overlap ? holdFirstSave() : undefined;
      state.mutateProviderInstance.mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("settings write failed"))),
      );
      await using screen = await render(panel());
      if (overlap) await commitInstanceField(screen, "display-name", "Work");
      await commitInstanceField(screen, "badge-label", "PX");
      await finish?.();
      await chooseInstanceIcon("Claude");
      const saved = savedInstance(overlap ? 2 : 1);
      expect(saved).toMatchObject({ icon: "claudeAgent" });
      if (overlap) expect(saved.displayName).toBe("Work");
      expect(saved).not.toHaveProperty("badgeLabel");
    },
  );

  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
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
    await using _screen = await render(panel());
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

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
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
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });

  it("lets a signed-out managed Codex account switch to the existing CLI", async () => {
    await setup();
    const codex = ProviderDriverKind.make("codex");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: codex,
          enabled: true,
          config: { enabled: true, setupMode: "managed" },
        },
      },
    };
    state.providerAuth = {
      instanceId: codexId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [{ id: "chatgpt-profile:work", name: "Work", description: null, type: "agent" }],
    };
    await setProviders([
      {
        ...provider(),
        auth: { status: "unauthenticated" },
        setup: { canAuthenticate: true, canInstall: true },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: codexId }));
    await expect.element(page.getByRole("button", { name: "Reconnect account" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use existing CLI" }).element());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: codexId,
        instance: {
          driver: codex,
          enabled: true,
          config: { enabled: true, setupMode: "existing" },
        },
      },
      {},
    );
  });
});
