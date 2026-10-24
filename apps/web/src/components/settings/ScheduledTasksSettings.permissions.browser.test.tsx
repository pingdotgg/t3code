import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: EnvironmentId; label: string }>,
  permissions: new Map<string, Atom.Writable<boolean>>(),
}));

vi.mock(import("../../state/server"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const tasks = Atom.make(AsyncResult.success({ tasks: [] }));
  const providers = Atom.make([]);
  return {
    EMPTY_SERVER_PROVIDERS: [],
    serverEnvironment: {
      scheduledTasksLive: () => tasks,
      providersValueAtom: () => providers,
      upsertScheduledTask: {
        permissionAtom: (id: string | null) => state.permissions.get(id ?? "")!,
      },
    },
  } as never;
});
vi.mock(
  import("./SettingsScopeContext"),
  () =>
    ({
      useSettingsScope: () => ({
        scope: { kind: "all", environmentIds: state.environments.map((env) => env.environmentId) },
        environments: state.environments,
        connectedEnvironments: state.environments,
        environment: state.environments[0],
        targets: [],
        target: null,
      }),
    }) as never,
);
vi.mock(
  import("../../state/environments"),
  () =>
    ({
      useEnvironment: (id: string) => state.environments.find((env) => env.environmentId === id),
      useEnvironmentHttpBaseUrl: () => null,
    }) as never,
);
vi.mock(import("../../state/entities"), () => ({ useProjects: () => [] }) as never);
vi.mock(
  import("../../hooks/useSettings"),
  () =>
    ({
      useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () =>
    ({
      useAtomCommand: () => vi.fn(),
    }) as never,
);
vi.mock(
  import("../../cloud/primaryCloudLinkState"),
  () =>
    ({
      usePrimaryCloudLinkState: () => null,
    }) as never,
);
vi.mock(import("../../state/session"), () => ({ readEnvironmentScope: () => true }) as never);
vi.mock(
  import("../ui/toast"),
  () =>
    ({
      toastManager: { add: vi.fn() },
      stackedThreadToast: (value: unknown) => value,
    }) as never,
);
vi.mock(import("../chat/ProviderModelPicker"), async () => {
  const { memo } = await import("react");
  return { ProviderModelPicker: memo(() => <></>) };
});
vi.mock(import("../WorktreeBaseBranchPicker"), () => ({ WorktreeBaseBranchPicker: () => <></> }));
// Keep layout independent of live settings state; exercise the real permission gate and editor.
vi.mock(
  import("./settingsLayout"),
  () =>
    ({
      SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
      SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
      SettingsSection: ({
        title,
        headerAction,
        children,
      }: {
        title: string;
        headerAction: ReactNode;
        children: ReactNode;
      }) => (
        <section>
          <h2>{title}</h2>
          {headerAction}
          {children}
        </section>
      ),
      SettingsRow: ({ title, description }: { title: string; description: string }) => (
        <div>
          {title}
          {description}
        </div>
      ),
    }) as never,
);

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

function setup() {
  state.environments = ["Restricted", "Permitted"].map((label) => ({
    environmentId: EnvironmentId.make(label.toLowerCase()),
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { platform: { machine: "server" } },
    },
    entry: { target: { _tag: "PrimaryConnectionTarget", label } },
  }));
  state.permissions = new Map([
    ["", Atom.make(false)],
    ["restricted", Atom.make(false)],
    ["permitted", Atom.make(true)],
  ]);
}

it("opens creation on a permitted environment when the primary denies it", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ScheduledTasksSettings />
    </RegistryContext.Provider>,
  );
  const create = screen.getByRole("button", { name: "New task" });
  await expect.element(create).toBeEnabled();
  await create.click();
  await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Permitted");
});

it("disables creation when the last environment loses permission and recovers on grant", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ScheduledTasksSettings />
    </RegistryContext.Provider>,
  );
  const create = screen.getByRole("button", { name: "New task" });
  await act(() => registry.set(state.permissions.get("permitted")!, false));
  await expect.element(create).toBeDisabled();
  await act(() => registry.set(state.permissions.get("permitted")!, true));
  await expect.element(create).toBeEnabled();
});
