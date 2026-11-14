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
  confirm: vi.fn<() => Promise<boolean>>(),
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

  it.each([false, true])(
    "preserves the latest repeated snapshot with coalesced echoes %s",
    async (coalesced) => {
      await setup();
      const first = { slug: "model-a", name: "Original A" };
      const second = { slug: "model-b", name: "Original B" };
      const stored = (name: string) => ({
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [customId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { customModels: [{ ...first, name }, second] },
          },
        },
      });
      state.settings = stored(first.name);
      await using screen = await render(panel({ targetInstanceId: customId }));
      const rename = async (slug: string, name: string) => {
        await screen.getByRole("button", { name: `Edit ${slug}`, exact: true }).click();
        await userEvent.fill(
          screen.getByRole("textbox", { name: "Display name", exact: true }),
          name,
        );
        await screen.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .element(screen.getByRole("textbox", { name: "Display name", exact: true }))
          .not.toBeInTheDocument();
      };
      await rename(first.slug, "Entered A");
      await rename(first.slug, "Entered B");
      await rename(first.slug, "Entered A");
      state.settings = stored("Entered A");
      await screen.rerender(panel({ targetInstanceId: customId }));
      if (!coalesced) {
        state.settings = stored("Entered B");
        await screen.rerender(panel({ targetInstanceId: customId }));
      }
      await rename(second.slug, "Changed second");
      expect(state.mutateProviderInstance.mock.calls[3]?.[0].instance.config.customModels).toEqual([
        { ...first, name: "Entered A" },
        { ...second, name: "Changed second" },
      ]);
      // The final A echo can be skipped when the stream coalesces the three writes.
      state.settings = stored("Entered A");
      await screen.rerender(panel({ targetInstanceId: customId }));
      await rename(first.slug, "Next edit");
      expect(state.mutateProviderInstance.mock.calls[4]?.[0].instance.config.customModels).toEqual([
        { ...first, name: "Next edit" },
        { ...second, name: "Changed second" },
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

  it.each(["before", "between", "after"] as const)(
    "keeps a later edit through rename/restore echoes (third reply %s echoes)",
    async (replyOrder) => {
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
        await screen.getByRole("button", { name: `Edit ${slug}`, exact: true }).click();
        await userEvent.fill(
          screen.getByRole("textbox", { name: "Display name", exact: true }),
          name,
        );
        await screen.getByRole("button", { name: "Save", exact: true }).click();
      };
      await rename("model-a", "Entered A");
      await act(() => replies[0]!());
      await rename("model-a", "Original A");
      await act(() => replies[1]!());
      await rename("model-b", "Entered B");
      if (replyOrder === "before") await act(() => replies[2]!());
      state.settings = stored([{ ...first, name: "Entered A" }, second]);
      await screen.rerender(panel({ targetInstanceId: customId }));
      if (replyOrder === "between") await act(() => replies[2]!());
      state.settings = stored([first, second]);
      await screen.rerender(panel({ targetInstanceId: customId }));
      if (replyOrder === "after") await act(() => replies[2]!());
      await rename("model-a", "Again A");
      expect(state.mutateProviderInstance.mock.calls[3]?.[0].instance.config.customModels).toEqual([
        { ...first, name: "Again A" },
        { ...second, name: "Entered B" },
      ]);
    },
  );

  it.each([false, true])(
    "retires acknowledged custom model saves across external refreshes (reply before echo %s)",
    async (replyBeforeEcho) => {
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
        await screen.getByRole("button", { name: `Edit ${slug}`, exact: true }).click();
        await userEvent.fill(
          screen.getByRole("textbox", { name: "Display name", exact: true }),
          name,
        );
        await screen.getByRole("button", { name: "Save", exact: true }).click();
      };
      await rename("model-a", "Entered A");
      if (replyBeforeEcho) await act(() => replies[0]!());
      await rename("model-b", "Entered B");
      if (replyBeforeEcho) await act(() => replies[1]!());
      state.settings = stored([
        { ...first, name: "Entered A" },
        { ...second, name: "Entered B" },
      ]);
      await screen.rerender(panel({ targetInstanceId: customId }));
      // An external writer restores an earlier list after the complete echo.
      state.settings = stored([{ ...first, name: "Entered A" }, second]);
      await screen.rerender(panel({ targetInstanceId: customId }));
      if (!replyBeforeEcho) await act(() => replies.forEach((reply) => reply()));
      await expect
        .element(screen.getByRole("button", { name: "Edit model-b", exact: true }))
        .toBeVisible();
      await rename("model-a", "Again A");
      expect(state.mutateProviderInstance.mock.calls[2]?.[0].instance.config.customModels).toEqual([
        { ...first, name: "Again A" },
        second,
      ]);
    },
  );

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
  it("commits interval drafts and allows retrying rejected edits", async () => {
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
    await userEvent.tab();
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
