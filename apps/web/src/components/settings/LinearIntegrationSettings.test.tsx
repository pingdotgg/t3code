import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const connectionState = vi.hoisted(() => ({
  data: {
    status: "authenticated" as "authenticated" | "unauthenticated" | "unverified",
    hasStoredToken: true,
    accountName: "Ada" as string | null,
    accountEmail: "ada@example.com" as string | null,
    projects: [] as ReadonlyArray<{ id: string; key: string; name: string }>,
    accounts: [] as ReadonlyArray<{
      credentialId: string;
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      projects: ReadonlyArray<{ id: string; key: string; name: string }>;
    }>,
  } as {
    status: "authenticated" | "unauthenticated" | "unverified";
    hasStoredToken: boolean;
    accountName: string | null;
    accountEmail: string | null;
    projects: ReadonlyArray<{ id: string; key: string; name: string }>;
    accounts: ReadonlyArray<{
      credentialId: string;
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      projects: ReadonlyArray<{ id: string; key: string; name: string }>;
    }>;
    environmentAccount?: {
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      projects: ReadonlyArray<{ id: string; key: string; name: string }>;
    };
  },
  error: "Linear status failed" as string | null,
}));
const scopeState = vi.hoisted(() => ({
  environment: null as {
    environmentId: string;
    serverConfig: { environment: { capabilities: { issues: boolean } } };
  } | null,
}));
const primaryState = vi.hoisted(() => ({
  environment: null as { environmentId: string } | null,
}));
const permission = vi.hoisted(() => ({ allowed: true }));
const commands = vi.hoisted(() => ({
  binding: vi.fn(),
  invalidate: vi.fn(),
  disconnect: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
  projectBindings: {} as Record<string, { credentialId?: string; repository: string } | null>,
}));
const projectsState = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<{ id: string; title: string; environmentId: string }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => permission.allowed }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => primaryState.environment,
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => ({ projectBindings: {} }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: scopeState.environment }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: unknown) => unknown) =>
    select({
      issueTracking: {
        connections: {
          linear: {
            projectBindings: settingsState.projectBindings,
          },
        },
      },
    }),
}));

vi.mock("../../state/entities", () => ({ useProjects: () => projectsState.projects }));
vi.mock("../../state/issueTracking", () => ({
  issueTrackingEnvironment: {
    status: vi.fn(),
    connect: { key: "connect", permissionAtom: vi.fn() },
    disconnect: { key: "disconnect", permissionAtom: vi.fn() },
    bind: { key: "binding", permissionAtom: vi.fn() },
  },
}));
vi.mock("../../state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/query")>();
  return {
    ...actual,
    useEnvironmentQuery: () => ({
      data: connectionState.data,
      error: connectionState.error,
      isPending: false,
      refresh: vi.fn(),
    }),
  };
});
vi.mock("../../state/issues", () => ({ issueEnvironment: { invalidate: "invalidate" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands | { key: keyof typeof commands }) =>
    commands[typeof command === "string" ? command : command.key],
}));
import { issueTrackingEnvironment } from "../../state/issueTracking";
import { AlertDialog, AlertDialogDescription, AlertDialogPopup } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { LinearConnectionDialog } from "../issue/LinearConnectionDialog";
import { LinearIntegrationSettings as LinearIntegrationScope } from "./LinearIntegrationSettings";

const ada = {
  credentialId: "user-1",
  status: "authenticated" as const,
  accountName: "Ada",
  accountEmail: "ada@example.com",
  projects: [{ id: "team-1", key: "ENG", name: "Engineering" }],
};
const grace = {
  credentialId: "user-2",
  status: "unverified" as const,
  accountName: "Grace",
  accountEmail: "grace@example.com",
  projects: [{ id: "team-2", key: "OPS", name: "Operations" }],
};

let mountedKey: unknown;
function LinearIntegrationSettings() {
  const section = LinearIntegrationScope();
  if (section.key !== mountedKey) hooks.reset();
  mountedKey = section.key;
  return (section.type as (props: unknown) => ReturnType<typeof LinearIntegrationScope>)(
    section.props,
  );
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return textContent(node.props.children);
}

describe("Linear integration settings", () => {
  beforeEach(() => {
    hooks.reset();
    mountedKey = undefined;
    vi.clearAllMocks();
    scopeState.environment = {
      environmentId: "primary",
      serverConfig: { environment: { capabilities: { issues: true } } },
    };
    primaryState.environment = { environmentId: "primary" };
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      projects: [],
      accounts: [ada, grace],
    };
    connectionState.error = "Linear status failed";
    settingsState.projectBindings = {};
    projectsState.projects = [];
    permission.allowed = true;
  });

  it("keeps Linear connections readable but not editable without write permission", () => {
    permission.allowed = false;
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    hooks.beginRender();
    const settings = LinearIntegrationSettings();
    expect(textContent(settings)).toContain("Ada");
    for (const label of ["Add account", "Disconnect"]) {
      const button = visitElements(
        settings,
        (element) =>
          element.type === Button &&
          textContent(element.props.children as ReactNode).includes(label),
      );
      expect(button?.props.disabled).toBe(true);
    }
    expect(visitElements(settings, (element) => element.type === Select)?.props.disabled).toBe(
      true,
    );
  });

  it("lists saved accounts, teams, and connection controls", () => {
    hooks.beginRender();
    const dialog = LinearIntegrationSettings();

    expect(visitElements(dialog, (element) => element.type === LinearConnectionDialog)).toBeNull();
    expect(textContent(dialog)).toContain("Ada");
    expect(textContent(dialog)).toContain("Engineering (ENG)");
    expect(textContent(dialog)).toContain("Grace");
    expect(textContent(dialog)).toContain("Operations (OPS)");
    expect(textContent(dialog)).toContain("Needs attention");
    expect(visitElements(dialog, (element) => element.props.role === "alert")?.props.children).toBe(
      "Linear status failed",
    );
    expect(
      visitElements(dialog, (element) => element.props.children === "Disconnect"),
    ).not.toBeNull();
  });

  it("disconnects one account only after warning about its linked projects", async () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "user-1", repository: "ENG" },
      deleted_project: { credentialId: "user-2", repository: "OPS" },
    };
    commands.disconnect.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    let dialog = LinearIntegrationSettings();
    const disconnectAda = visitElements(
      dialog,
      (element) =>
        element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
    );
    (disconnectAda?.props.onClick as (() => void) | undefined)?.();

    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    const warning = visitElements(dialog, (element) => element.type === AlertDialogDescription);
    expect(textContent(warning)).toContain(
      "All T3 projects linked to this account will lose Linear",
    );
    const confirm = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Disconnect account",
    );
    await (confirm?.props.onClick as (() => Promise<void>) | undefined)?.();

    expect(commands.disconnect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", credentialId: "user-1" },
    });
    expect(commands.invalidate).toHaveBeenCalledWith({ environmentId: "primary", input: {} });
  });

  it("blocks the open disconnect confirmation while disconnect access is revoked", async () => {
    connectionState.error = null;
    commands.disconnect.mockResolvedValue(AsyncResult.success(undefined));
    const confirmButton = (settings: ReturnType<typeof LinearIntegrationSettings>) =>
      visitElements(
        settings,
        (element) => element.type === Button && element.props.children === "Disconnect account",
      );

    hooks.beginRender();
    const disconnectAda = visitElements(
      LinearIntegrationSettings(),
      (element) =>
        element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
    );
    (disconnectAda!.props.onClick as () => void)();

    permission.allowed = false;
    hooks.beginRender();
    let confirm = confirmButton(LinearIntegrationSettings());
    expect(confirm?.props.disabled).toBe(true);
    await (confirm!.props.onClick as () => Promise<void> | undefined)();
    expect(commands.disconnect).not.toHaveBeenCalled();

    permission.allowed = true;
    hooks.beginRender();
    confirm = confirmButton(LinearIntegrationSettings());
    expect(confirm?.props.disabled).toBe(false);
    await (confirm!.props.onClick as () => Promise<void>)();
    expect(commands.disconnect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", credentialId: "user-1" },
    });
  });

  it("shows a disconnect failure inside the open confirmation dialog", async () => {
    connectionState.error = null;
    commands.disconnect.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Could not disconnect Linear"))),
    );

    hooks.beginRender();
    let dialog = LinearIntegrationSettings();
    const disconnectAda = visitElements(
      dialog,
      (element) =>
        element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
    );
    (disconnectAda?.props.onClick as (() => void) | undefined)?.();

    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    const confirm = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Disconnect account",
    );
    await (confirm?.props.onClick as (() => Promise<void>) | undefined)?.();

    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    const alertDialog = visitElements(dialog, (element) => element.type === AlertDialogPopup);
    expect(
      visitElements(alertDialog, (element) => element.props.role === "alert")?.props.children,
    ).toBe("Could not disconnect Linear");

    const alert = visitElements(dialog, (element) => element.type === AlertDialog);
    (alert?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(false);
    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    expect(visitElements(dialog, (element) => element.props.role === "alert")).toBeNull();
  });

  it("stores an account and team per project and uses null for an unbound project", async () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "user-1", repository: "ENG" },
      deleted_project: { credentialId: "user-2", repository: "OPS" },
    };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    let dialog = LinearIntegrationSettings();
    const projectSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    const operations = visitElements(
      dialog,
      (element) => element.type === SelectItem && textContent(element).includes("Operations (OPS)"),
    );
    (projectSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      operations?.props.value as string,
    );
    await commands.binding.mock.results[0]?.value;
    await Promise.resolve();
    expect(commands.binding).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: {
        provider: "linear",
        projectId: "project_1",
        binding: { credentialId: "user-2", repository: "OPS" },
      },
    });

    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    const unbound = visitElements(
      dialog,
      (element) => element.type === SelectItem && element.props.children === "Not connected",
    );
    const rerenderedSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    (rerenderedSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      unbound?.props.value as string,
    );
    await commands.binding.mock.results[1]?.value;
    await Promise.resolve();
    expect(commands.binding).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: { provider: "linear", projectId: "project_1", binding: null },
    });
    expect(commands.invalidate).toHaveBeenCalledWith({ environmentId: "primary", input: {} });
  });

  it("blocks an open team choice while bind access is revoked", async () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));
    const render = () => {
      hooks.beginRender();
      const settings = LinearIntegrationSettings();
      return {
        settings,
        select: visitElements(
          settings,
          (element) => element.type === Select && element.props.value !== undefined,
        )!,
        items: [
          visitElements(
            settings,
            (element) => element.type === SelectItem && element.props.children === "Not connected",
          )!,
          visitElements(
            settings,
            (element) =>
              element.type === SelectItem && textContent(element).includes("Operations (OPS)"),
          )!,
        ],
      };
    };
    const opened = render();

    permission.allowed = false;
    const revoked = render();
    expect(revoked.items.map((item) => item.props.disabled)).toEqual([true, true]);
    (revoked.select.props.onValueChange as (value: string) => void)(
      opened.items[1]!.props.value as string,
    );
    await Promise.resolve();
    expect(commands.binding).not.toHaveBeenCalled();
    expect(
      visitElements(render().settings, (element) => element.props.role === "alert"),
    ).toBeNull();

    permission.allowed = true;
    const restored = render();
    expect(restored.items.map((item) => item.props.disabled)).toEqual([false, false]);
    (restored.select.props.onValueChange as (value: string) => void)(
      restored.items[1]!.props.value as string,
    );
    await commands.binding.mock.results[0]?.value;
    expect(commands.binding).toHaveBeenCalledTimes(1);
    expect(commands.binding).toHaveBeenCalledWith({
      environmentId: "primary",
      input: {
        provider: "linear",
        projectId: "project_1",
        binding: { credentialId: "user-2", repository: "OPS" },
      },
    });
  });

  it("shows a stored binding as needing attention when its account or team is unavailable", () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "missing-user", repository: "GONE" },
    };

    hooks.beginRender();
    const dialog = LinearIntegrationSettings();
    const trigger = visitElements(
      dialog,
      (element) => element.type === SelectTrigger && element.props["aria-invalid"] === true,
    );
    const selected = visitElements(trigger, (element) => element.type === SelectValue);

    expect(selected?.props.children).toBe("Needs attention");
    expect(
      visitElements(
        dialog,
        (element) =>
          element.type === SelectItem &&
          element.props.disabled === true &&
          textContent(element).includes("Unavailable"),
      ),
    ).not.toBeNull();
  });

  it("shows and clears a current stored binding when no accounts are available", async () => {
    connectionState.data = {
      status: "unverified",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      projects: [],
      accounts: [],
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "missing-user", repository: "GONE" },
    };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    const dialog = LinearIntegrationSettings();
    expect(textContent(dialog)).toContain("Project connections");
    expect(textContent(dialog)).toContain("Needs attention");
    const projectSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    const unbound = visitElements(
      dialog,
      (element) => element.type === SelectItem && element.props.children === "Not connected",
    );
    (projectSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      unbound?.props.value as string,
    );
    await commands.binding.mock.results[0]?.value;
    await Promise.resolve();

    expect(commands.binding).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", projectId: "project_1", binding: null },
    });
    expect(commands.invalidate).toHaveBeenCalledWith({ environmentId: "primary", input: {} });
  });

  it("keeps project team editing available for an environment API token", async () => {
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: false,
      accountName: "Environment account",
      accountEmail: null,
      projects: [
        { id: "team-1", key: "ENG", name: "Engineering" },
        { id: "team-2", key: "OPS", name: "Operations" },
      ],
      accounts: [],
    };
    connectionState.data.environmentAccount = {
      status: "authenticated",
      accountName: "Environment account",
      accountEmail: null,
      projects: connectionState.data.projects,
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = { project_1: null };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    let dialog = LinearIntegrationSettings();
    expect(textContent(dialog)).toContain("Project connections");
    expect(textContent(dialog)).toContain("Engineering (ENG)");
    const operations = visitElements(
      dialog,
      (element) => element.type === SelectItem && textContent(element).includes("Operations (OPS)"),
    );
    const projectSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    expect(projectSelect?.props.value).toBe("__unmapped__");
    (projectSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      operations?.props.value as string,
    );
    await commands.binding.mock.results[0]?.value;

    expect(commands.binding).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: { provider: "linear", projectId: "project_1", binding: { repository: "OPS" } },
    });

    hooks.beginRender();
    dialog = LinearIntegrationSettings();
    const unbound = visitElements(
      dialog,
      (element) => element.type === SelectItem && element.props.children === "Not connected",
    );
    const rerenderedSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    (rerenderedSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      unbound?.props.value as string,
    );
    await commands.binding.mock.results[1]?.value;

    expect(commands.binding).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: { provider: "linear", projectId: "project_1", binding: null },
    });
  });

  it("offers environment and saved teams together", () => {
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Saved account",
      accountEmail: null,
      projects: [],
      accounts: [
        {
          credentialId: "saved-user",
          status: "authenticated",
          accountName: "Saved account",
          accountEmail: null,
          projects: [{ id: "team-saved", key: "SAVED", name: "Saved" }],
        },
      ],
      environmentAccount: {
        status: "authenticated",
        accountName: "Environment account",
        accountEmail: null,
        projects: [{ id: "team-env", key: "ENV", name: "Environment" }],
      },
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];

    hooks.beginRender();
    const dialog = LinearIntegrationSettings();

    expect(textContent(dialog)).toContain("Environment (ENV)");
    expect(textContent(dialog)).toContain("Saved (SAVED)");
  });

  it("shows and clears a project linked to an invalid environment token", async () => {
    connectionState.data = {
      status: "unverified",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      projects: [],
      accounts: [],
      environmentAccount: {
        status: "unverified",
        accountName: "Environment account",
        accountEmail: null,
        projects: [],
      },
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = { project_1: { repository: "ENG" } };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    const dialog = LinearIntegrationSettings();
    expect(textContent(dialog)).toContain("Needs attention");
    const unbound = visitElements(
      dialog,
      (element) => element.type === SelectItem && element.props.children === "Not connected",
    );
    const projectSelect = visitElements(
      dialog,
      (element) => element.type === Select && element.props.value !== undefined,
    );
    (projectSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      unbound?.props.value as string,
    );
    await commands.binding.mock.results[0]?.value;

    expect(commands.binding).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { provider: "linear", projectId: "project_1", binding: null },
    });
  });

  it("does not load accounts without a supported environment", () => {
    scopeState.environment = null;
    hooks.beginRender();
    const settings = LinearIntegrationSettings();
    expect(visitElements(settings, (element) => element.type === Button)?.props.disabled).toBe(
      true,
    );
    expect(issueTrackingEnvironment.status).not.toHaveBeenCalled();
    expect(
      visitElements(settings, (element) => element.type === LinearConnectionDialog),
    ).toBeNull();
  });
  it.each([
    ["a different primary environment", { environmentId: "primary" }],
    ["no primary environment", null],
  ])("configures the selected environment with %s", async (_, primaryEnvironment) => {
    primaryState.environment = primaryEnvironment;
    scopeState.environment = {
      environmentId: "remote",
      serverConfig: { environment: { capabilities: { issues: true } } },
    };
    connectionState.error = null;
    projectsState.projects = [
      { id: "project_primary", title: "Primary project", environmentId: "primary" },
      { id: "project_remote", title: "Remote project", environmentId: "remote" },
    ];
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));
    commands.disconnect.mockResolvedValue(AsyncResult.success(undefined));
    const button = (settings: ReturnType<typeof LinearIntegrationSettings>, label: string) =>
      visitElements(
        settings,
        (element) =>
          element.type === Button &&
          (element.props["aria-label"] === label || element.props.children === label),
      )!;

    hooks.beginRender();
    let settings = LinearIntegrationSettings();
    expect(issueTrackingEnvironment.status).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { provider: "linear" },
    });
    for (const command of ["connect", "disconnect", "bind"] as const) {
      expect(issueTrackingEnvironment[command].permissionAtom).toHaveBeenCalledWith("remote");
    }
    expect(textContent(settings)).toContain("Remote project");
    expect(textContent(settings)).not.toContain("Primary project");

    const addAccount = visitElements(
      settings,
      (element) => element.type === Button && textContent(element).includes("Add account"),
    )!;
    expect(addAccount.props.disabled).toBe(false);
    (addAccount.props.onClick as () => void)();
    hooks.beginRender();
    settings = LinearIntegrationSettings();
    expect(
      visitElements(settings, (element) => element.type === LinearConnectionDialog)?.props
        .environmentId,
    ).toBe("remote");

    const operations = visitElements(
      settings,
      (element) => element.type === SelectItem && textContent(element).includes("Operations (OPS)"),
    )!;
    (
      visitElements(settings, (element) => element.type === Select)!.props.onValueChange as (
        value: string,
      ) => void
    )(operations.props.value as string);
    await commands.binding.mock.results[0]?.value;
    expect(commands.binding).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        provider: "linear",
        projectId: "project_remote",
        binding: { credentialId: "user-2", repository: "OPS" },
      },
    });

    hooks.beginRender();
    (
      button(LinearIntegrationSettings(), "Disconnect Ada from Linear").props.onClick as () => void
    )();
    hooks.beginRender();
    await (
      button(LinearIntegrationSettings(), "Disconnect account").props.onClick as () => Promise<void>
    )();
    expect(commands.disconnect).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { provider: "linear", credentialId: "user-1" },
    });
    expect(commands.invalidate).toHaveBeenCalledWith({ environmentId: "remote", input: {} });
  });

  it("drops an open account action when the selected environment changes", () => {
    connectionState.error = null;
    hooks.beginRender();
    let settings = LinearIntegrationSettings();
    (
      visitElements(
        settings,
        (element) =>
          element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
      )!.props.onClick as () => void
    )();
    (
      visitElements(
        settings,
        (element) => element.type === Button && textContent(element).includes("Add account"),
      )!.props.onClick as () => void
    )();
    hooks.beginRender();
    settings = LinearIntegrationSettings();
    expect(visitElements(settings, (element) => element.type === AlertDialog)?.props.open).toBe(
      true,
    );

    scopeState.environment = {
      environmentId: "remote",
      serverConfig: { environment: { capabilities: { issues: true } } },
    };
    hooks.beginRender();
    settings = LinearIntegrationSettings();
    expect(visitElements(settings, (element) => element.type === AlertDialog)?.props.open).toBe(
      false,
    );
    expect(
      visitElements(settings, (element) => element.type === LinearConnectionDialog),
    ).toBeNull();
  });
});
