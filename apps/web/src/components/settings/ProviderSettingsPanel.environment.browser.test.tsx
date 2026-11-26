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
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { m } from "../../i18n/messages";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  config: null as unknown as Atom.Writable<unknown>,
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
  enableInference: vi.fn(),
  manageInference: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make<unknown>(null).pipe(Atom.keepAlive);
  state.config = config;
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
      inferenceProxy: {
        ...actual.serverEnvironment.inferenceProxy,
        canConnect: () => Atom.make(state.canManageProviders),
        manageInference: {
          ...actual.serverEnvironment.inferenceProxy.manageInference,
          permissionAtom: () => Atom.make(state.canManageProviders),
        },
      },
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
      "inference:enable-routing": state.enableInference,
      "inference:manage": state.manageInference,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("~/localApi"), async (original) => {
  const api = { dialogs: { confirm: state.confirm } };
  return {
    ...(await original()),
    readLocalApi: (() => api) as never,
    ensureLocalApi: (() => api) as never,
  };
});
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
  await act(async () => appAtomRegistry.set(state.config, null));
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
  state.enableInference
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ environmentId, label: "Remote device" }));
  state.manageInference.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.confirm.mockReset().mockResolvedValue(false);
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
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

  it("enables inference routing directly and keeps the switch off when no host is available", async () => {
    await setup();
    state.canWriteSettings = false;
    await act(async () =>
      appAtomRegistry.set(state.config, {
        environment: { capabilities: { inferenceProxy: true } },
      }),
    );
    await setProviders([provider()]);
    let reply: (result: AsyncResult.AsyncResult<never, Error>) => void = () => {};
    state.enableInference.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));

    await using screen = await render(panel({ targetInstanceId: codexId }));
    const proxySwitch = screen.getByRole("switch", { name: "Inference routing" });
    expect(proxySwitch.element()).toBeEnabled();
    await userEvent.click(proxySwitch);
    await expect.element(proxySwitch).toBeDisabled();
    await expect.element(proxySwitch).not.toBeChecked();
    expect(state.enableInference).toHaveBeenCalledExactlyOnceWith({
      consumer: { environmentId, label: "Remote device" },
      driver: "codex",
      environments: expect.any(Array),
      resolve: m,
    });
    await act(async () =>
      reply(AsyncResult.failure(Cause.fail(new Error("No connected inference host.")))),
    );
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("No connected inference host.");
    await userEvent.click(screen.getByRole("button", { name: "Set up accounts here" }));
    const localSetup = screen.getByText("Loading accounts…");
    await expect.element(localSetup).toBeVisible();
    await expect.element(proxySwitch).toBeEnabled();
    await expect.element(proxySwitch).not.toBeChecked();

    await userEvent.click(proxySwitch);
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { inferenceEnabled: true, inferenceHostId: environmentId },
        },
      },
    };
    await screen.rerender(panel({ targetInstanceId: codexId }));
    await expect.element(proxySwitch).toBeChecked();
    await expect.element(screen.getByText(/This inference route is incomplete/)).toBeVisible();
    await userEvent.click(proxySwitch);
    expect(state.manageInference).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { operation: "removeRoute", instanceId: codexId },
    });
    state.settings = DEFAULT_UNIFIED_SETTINGS;
    await screen.rerender(panel({ targetInstanceId: codexId }));
    await expect.element(proxySwitch).not.toBeChecked();
    await expect.element(localSetup).not.toBeInTheDocument();
  });

  it.each(["codex", "opencode", "pi"] as const)(
    "turns %s proxy routing on and off while preserving its native account behavior",
    async (driver) => {
      const providerId = ProviderInstanceId.make(driver);
      const personalId = ProviderInstanceId.make(`${driver}_work`);
      await setup();
      const native = {
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        environment: [{ name: "NATIVE_PROFILE", value: "personal", sensitive: false }],
        config: {
          setupMode: "existing",
          homePath: "/native/codex",
          launchArgs: "--config allow_telemetry=false",
          inferenceEnabled: false,
          inferenceHostId: environmentId,
          inferenceHostLabel: "Remote device",
          inferenceBaseUrl: "http://127.0.0.1:8318",
          inferenceKey: "fixture-grant",
          inferenceModels: ["gpt-fixture"],
          inferenceHomePath: "/state/inference/codex",
        },
      };
      state.settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [providerId]: native,
          [personalId]: { driver: ProviderDriverKind.make(driver), displayName: "Personal" },
          [ProviderInstanceId.make("codex_traex")]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Traex",
            config: { launchArgs: '-c model_provider="traex"' },
          },
        },
      };
      await act(async () =>
        appAtomRegistry.set(state.config, {
          environment: { capabilities: { inferenceProxy: true } },
        }),
      );
      await setProviders([
        {
          ...provider(),
          instanceId: providerId,
          driver: ProviderDriverKind.make(driver),
          setup: { canAuthenticate: true, canInstall: true },
        },
      ]);
      await using screen = await render(panel({ targetInstanceId: providerId }));
      await expect.element(screen.getByText("Personal", { exact: true })).toBeVisible();
      await userEvent.click(screen.getByRole("switch", { name: "Inference routing" }));
      expect(state.enableInference).toHaveBeenCalledExactlyOnceWith({
        consumer: { environmentId, label: "Remote device" },
        driver,
        environments: expect.any(Array),
        resolve: m,
        preferredHostId: environmentId,
        preserveProviderEnabled: true,
      });
      state.settings = {
        ...state.settings,
        providerInstances: {
          ...state.settings.providerInstances,
          [providerId]: { ...native, config: { ...native.config, inferenceEnabled: true } },
        },
      };
      await screen.rerender(panel({ targetInstanceId: providerId }));
      await expect
        .element(screen.getByText(/Using Remote device for inference via the CLI proxy/))
        .toBeVisible();
      if (driver === "codex") {
        await expect.element(screen.getByText("Personal", { exact: true })).not.toBeInTheDocument();
        await expect
          .element(screen.getByText("Personal is hidden while the proxy is on", { exact: false }))
          .toBeVisible();
        await expect
          .element(screen.getByRole("heading", { name: "Account", exact: true }))
          .not.toBeInTheDocument();
      } else {
        await expect.element(screen.getByText("Personal", { exact: true })).toBeVisible();
        await expect
          .element(screen.getByRole("heading", { name: "Account", exact: true }))
          .toBeVisible();
      }
      await expect.element(screen.getByText("Traex", { exact: true })).toBeVisible();
      await userEvent.click(screen.getByRole("switch", { name: "Inference routing" }));
      expect(state.manageInference).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { operation: "removeRoute", instanceId: providerId },
      });
      expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "builds a custom model save on the last one before its config echo (replied %s)",
    async (replied) => {
      await setup();
      const first = { slug: "model-a", name: "Original A" };
      const second = { slug: "model-b", name: "Original B" };
      const stored = (customModels: ReadonlyArray<{ slug: string; name: string }>) => ({
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [customId]: { driver: ProviderDriverKind.make("codex"), config: { customModels } },
        },
      });
      state.settings = stored([first, second]);
      const replies: Array<() => void> = [];
      state.mutateProviderInstance.mockImplementation(
        () => new Promise((resolve) => replies.push(() => resolve(AsyncResult.success({})))),
      );
      await using screen = await render(panel({ targetInstanceId: customId }));
      const rename = async (slug: string, name: string) => {
        await userEvent.click(screen.getByRole("button", { name: `Edit ${slug}`, exact: true }));
        await userEvent.fill(
          screen.getByRole("textbox", { name: "Display name", exact: true }),
          name,
        );
        await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
      };

      await rename("model-a", "Entered A");
      if (replied) await act(() => replies[0]!());
      await rename("model-b", "Entered B");

      expect(state.mutateProviderInstance.mock.calls[1]?.[0]).toEqual({
        operation: "upsert",
        instanceId: customId,
        instance: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            customModels: [
              { ...first, name: "Entered A" },
              { ...second, name: "Entered B" },
            ],
          },
        },
      });

      // The first save's echo lands after both replied, ahead of the second's.
      await act(() => replies.forEach((reply) => reply()));
      state.settings = stored([{ ...first, name: "Entered A" }, second]);
      await screen.rerender(panel({ targetInstanceId: customId }));
      await rename("model-a", "Again A");
      expect(state.mutateProviderInstance.mock.calls[2]?.[0].instance.config.customModels).toEqual([
        { ...first, name: "Again A" },
        { ...second, name: "Entered B" },
      ]);
    },
  );

  it("preserves a failed model draft for retry without including it in another edit", async () => {
    await setup();
    const first = { slug: "model-a", name: "Original A" };
    const second = { slug: "model-b", name: "Original B" };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { customModels: [first, second] },
        },
      },
    };
    state.mutateProviderInstance
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Still offline"))));
    await using screen = await render(panel({ targetInstanceId: customId }));
    await screen.getByRole("button", { name: "Edit model-a", exact: true }).click();
    const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
    await userEvent.fill(displayName, "Entered A");
    const save = screen.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect.element(save).toBeEnabled();
    await expect.element(displayName).toHaveValue("Entered A");
    await save.click();
    await expect.element(save).toBeEnabled();
    expect(state.mutateProviderInstance.mock.calls[1]?.[0].instance.config.customModels).toEqual([
      { ...first, name: "Entered A" },
      second,
    ]);
    await screen.getByRole("button", { name: "Cancel", exact: true }).click();
    await screen.getByRole("button", { name: "Edit model-b", exact: true }).click();
    await userEvent.fill(displayName, "Entered B");
    await save.click();
    await expect.element(displayName).not.toBeInTheDocument();
    expect(state.mutateProviderInstance.mock.calls[2]?.[0].instance.config.customModels).toEqual([
      first,
      { ...second, name: "Entered B" },
    ]);
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

describe("EnvironmentProviderSettings provider list", () => {
  it("selects a provider when its row is clicked near the edge", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel());
    const select = page.getByRole("button", { name: "Select Claude" });
    await expect.element(select).toHaveAttribute("aria-pressed", "false");
    const row = page.elementLocator(select.element().closest('[data-slot="settings-row"]')!);

    await userEvent.click(row, { position: { x: 3, y: 3 } });

    await expect.element(select).toHaveAttribute("aria-pressed", "true");
  });
});

describe("EnvironmentProviderSettings account email", () => {
  it("keeps the real email until the hide blur finishes", async () => {
    await setup();
    const email = "developer@example.com";
    await setProviders([{ ...provider(), auth: { status: "authenticated", email } }]);
    await using _screen = await render(panel({ targetInstanceId: codexId }));
    const toggle = page.getByRole("button", { name: "Toggle account email visibility" });
    const button = toggle.element() as HTMLButtonElement;

    await act(() => button.click());
    for (const animation of button.getAnimations()) animation.finish();
    await expect.element(toggle).toHaveTextContent(email);

    await act(() => button.click());
    const blur = button
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === "filter",
      )!;
    blur.pause();
    expect(button.textContent).toBe(email);

    await act(() => blur.finish());
    await expect.element(toggle).not.toHaveTextContent(email);
  });
});

describe("EnvironmentProviderSettings instance removal", () => {
  it("resets a configured default instance only once the user confirms", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { binaryPath: "/opt/codex/bin/codex" },
        },
      },
    };
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: codexId }));
    const reset = page.getByRole("button", { name: "Reset Codex provider settings to default" });
    await userEvent.click(reset);

    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledOnce();

    state.confirm.mockResolvedValue(true);
    await userEvent.click(reset);
    await vi.waitFor(() =>
      expect(state.mutateProviderInstance).toHaveBeenCalledWith({
        operation: "remove",
        instanceId: codexId,
      }),
    );
  });

  it("warns that resetting an enabled default-off provider turns it off", async () => {
    await setup();
    const antigravityId = ProviderInstanceId.make("antigravity");
    const antigravity = ProviderDriverKind.make("antigravity");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [antigravityId]: {
          driver: antigravity,
          enabled: true,
          config: { binaryPath: "/opt/antigravity/bin/agy" },
        },
      },
    };
    await setProviders([{ ...provider(), instanceId: antigravityId, driver: antigravity }]);
    await using _screen = await render(panel({ targetInstanceId: antigravityId }));
    await userEvent.click(page.getByRole("button", { name: /^Reset .* provider settings/ }));

    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("It will also be turned off."),
      {
        variant: "destructive",
      },
    );
    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
  });

  it("deletes a custom instance only once the user confirms", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    await using _screen = await render(panel({ targetInstanceId: customId }));
    const remove = page.getByRole("button", { name: `Delete instance ${customId}` });
    await userEvent.click(remove);

    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledOnce();

    state.confirm.mockResolvedValue(true);
    await userEvent.click(remove);
    await vi.waitFor(() =>
      expect(state.mutateProviderInstance).toHaveBeenCalledWith({
        operation: "remove",
        instanceId: customId,
      }),
    );
  });
});

describe("EnvironmentProviderSettings health check interval", () => {
  it("commits interval drafts on blur and Enter and allows retrying rejected edits", async () => {
    await setup();
    await using _screen = await render(panel());
    const input = page.getByRole("textbox", { name: "Provider health check interval in seconds" });

    await userEvent.type(input, "{ArrowUp}{ArrowDown}");
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([330, 300]);
    state.updateSettings.mockClear();

    // Replacing 300 with 120 passes through 30, 3, an empty field, 1 and 12.
    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}120");
    await expect.element(input).toHaveValue("120");
    expect(state.updateSettings).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([120]);

    await act(() => state.updateSettings.mock.calls.at(-1)?.[1]?.onFailed?.());
    await expect.element(input).toHaveValue("300");
    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}120");
    // An Enter that confirms an IME candidate must not commit.
    for (const composition of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ]) {
      await act(() =>
        input.element().dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ...composition,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    }
    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveFocus();
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([120, 120]);

    const rejectPrevious = state.updateSettings.mock.calls.at(-1)?.[1]?.onFailed;
    await userEvent.type(input, "{ArrowUp}");
    await act(() => rejectPrevious?.());
    await expect.element(input).toHaveValue("150");
  });

  it("restores the saved interval when a cleared field loses focus", async () => {
    await setup();
    await using _screen = await render(panel());
    const input = page.getByRole("textbox", { name: "Provider health check interval in seconds" });

    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}");
    await userEvent.tab();

    await expect.element(input).toHaveValue("300");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});
