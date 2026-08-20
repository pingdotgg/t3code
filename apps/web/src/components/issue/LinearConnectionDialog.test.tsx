import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
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
    teams: [] as ReadonlyArray<{ id: string; key: string; name: string }>,
    accounts: [] as ReadonlyArray<{
      credentialId: string;
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      teams: ReadonlyArray<{ id: string; key: string; name: string }>;
    }>,
  } as {
    status: "authenticated" | "unauthenticated" | "unverified";
    hasStoredToken: boolean;
    accountName: string | null;
    accountEmail: string | null;
    teams: ReadonlyArray<{ id: string; key: string; name: string }>;
    accounts: ReadonlyArray<{
      credentialId: string;
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      teams: ReadonlyArray<{ id: string; key: string; name: string }>;
    }>;
    environmentAccount?: {
      status: "authenticated" | "unauthenticated" | "unverified";
      accountName: string;
      accountEmail: string | null;
      teams: ReadonlyArray<{ id: string; key: string; name: string }>;
    };
  },
  error: "Linear status failed" as string | null,
}));
const commands = vi.hoisted(() => ({
  binding: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  settings: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
  projectBindings: {} as Record<string, { credentialId: string; teamKey: string } | null>,
  projectTeams: {} as Record<string, string>,
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

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: unknown) => unknown) =>
    select({
      issueTracking: {
        linear: {
          projectBindings: settingsState.projectBindings,
          projectTeams: settingsState.projectTeams,
        },
      },
    }),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary" }),
}));

vi.mock("../../state/entities", () => ({ useProjects: () => projectsState.projects }));
vi.mock("../../state/issueTracking", () => ({
  issueTrackingEnvironment: {
    linearStatus: vi.fn(),
    linearConnect: "connect",
    linearDisconnect: "disconnect",
    linearSetProjectBinding: "binding",
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
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "settings" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
import { AlertDialog, AlertDialogDescription, AlertDialogPopup } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DialogPopup } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { LinearConnectionDialog } from "./LinearConnectionDialog";

const ada = {
  credentialId: "user-1",
  status: "authenticated" as const,
  accountName: "Ada",
  accountEmail: "ada@example.com",
  teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
};
const grace = {
  credentialId: "user-2",
  status: "unverified" as const,
  accountName: "Grace",
  accountEmail: "grace@example.com",
  teams: [{ id: "team-2", key: "OPS", name: "Operations" }],
};

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return textContent(node.props.children);
}

describe("Linear connection dialog", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [],
      accounts: [ada, grace],
    };
    connectionState.error = "Linear status failed";
    settingsState.projectBindings = {};
    projectsState.projects = [];
    settingsState.projectTeams = {};
  });

  it("adds API keys and lists every saved account with its teams", () => {
    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });

    expect(visitElements(dialog, (element) => element.type === DialogPopup)).not.toBeNull();
    expect(
      visitElements(
        dialog,
        (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
      ),
    ).not.toBeNull();
    expect(textContent(dialog)).toContain("Add API key");
    expect(textContent(dialog)).not.toContain("Replace");
    expect(textContent(dialog)).toContain("Ada");
    expect(textContent(dialog)).toContain("ada@example.com");
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

  it("shows a failed connection inside the dialog", async () => {
    connectionState.data = {
      status: "unauthenticated",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      teams: [],
      accounts: [],
    };
    connectionState.error = null;
    commands.connect.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Invalid Linear API key"))),
    );
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged: vi.fn() };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "bad-key" } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")?.props.children).toBe(
      "Invalid Linear API key",
    );

    const done = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Done",
    );
    (done?.props.onClick as (() => void) | undefined)?.();
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")).toBeNull();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not change the provider filter when adding another key", async () => {
    connectionState.error = null;
    commands.connect.mockResolvedValue(AsyncResult.success(undefined));
    const onProviderChanged = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(
      dialog,
      (element) => element.type === Input && element.props["aria-label"] === "Linear API key",
    );
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "new-key" } });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    await commands.connect.mock.results[0]?.value;
    await Promise.resolve();

    expect(commands.connect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: { token: "new-key", mode: "add" },
    });
    expect(onProviderChanged).toHaveBeenCalledWith("updated");
  });

  it("disconnects one account only after warning about its linked projects", async () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "user-1", teamKey: "ENG" },
      deleted_project: { credentialId: "user-2", teamKey: "OPS" },
    };
    commands.disconnect.mockResolvedValue(AsyncResult.success(undefined));
    const onProviderChanged = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const disconnectAda = visitElements(
      dialog,
      (element) =>
        element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
    );
    (disconnectAda?.props.onClick as (() => void) | undefined)?.();

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
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
      input: { credentialId: "user-1" },
    });
    expect(onProviderChanged).toHaveBeenCalledWith("unavailable");
  });

  it("shows a disconnect failure inside the open confirmation dialog", async () => {
    connectionState.error = null;
    commands.disconnect.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Could not disconnect Linear"))),
    );
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged: vi.fn() };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const disconnectAda = visitElements(
      dialog,
      (element) =>
        element.type === Button && element.props["aria-label"] === "Disconnect Ada from Linear",
    );
    (disconnectAda?.props.onClick as (() => void) | undefined)?.();

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const confirm = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Disconnect account",
    );
    await (confirm?.props.onClick as (() => Promise<void>) | undefined)?.();

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const alertDialog = visitElements(dialog, (element) => element.type === AlertDialogPopup);
    expect(
      visitElements(alertDialog, (element) => element.props.role === "alert")?.props.children,
    ).toBe("Could not disconnect Linear");

    const alert = visitElements(dialog, (element) => element.type === AlertDialog);
    (alert?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(false);
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    expect(visitElements(dialog, (element) => element.props.role === "alert")).toBeNull();
  });

  it("stores an account and team per project and uses null for an unbound project", async () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "user-1", teamKey: "ENG" },
      deleted_project: { credentialId: "user-2", teamKey: "OPS" },
    };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));
    const onProviderChanged = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
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
        projectId: "project_1",
        binding: { credentialId: "user-2", teamKey: "OPS" },
      },
    });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
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
      input: { projectId: "project_1", binding: null },
    });
    expect(onProviderChanged).toHaveBeenLastCalledWith("unavailable");
  });

  it("shows a stored binding as needing attention when its account or team is unavailable", () => {
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "missing-user", teamKey: "GONE" },
    };

    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });
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
      teams: [],
      accounts: [],
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = {
      project_1: { credentialId: "missing-user", teamKey: "GONE" },
    };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));
    const onProviderChanged = vi.fn();
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged };

    hooks.beginRender();
    const dialog = LinearConnectionDialog(props);
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
      input: { projectId: "project_1", binding: null },
    });
    expect(onProviderChanged).toHaveBeenCalledWith("unavailable");
  });

  it("keeps project team editing available for an environment API token", async () => {
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: false,
      accountName: "Environment account",
      accountEmail: null,
      teams: [
        { id: "team-1", key: "ENG", name: "Engineering" },
        { id: "team-2", key: "OPS", name: "Operations" },
      ],
      accounts: [],
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectBindings = { project_1: null };
    settingsState.projectTeams = { project_1: "ENG" };
    commands.settings.mockResolvedValue(AsyncResult.success(undefined));
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged: vi.fn() };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
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
    await commands.settings.mock.results[0]?.value;

    expect(commands.settings).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: {
        patch: {
          issueTracking: {
            linear: {
              projectBindingsToDelete: ["project_1"],
              projectTeams: { project_1: "OPS" },
            },
          },
        },
      },
    });

    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
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
    await commands.settings.mock.results[1]?.value;

    expect(commands.settings).toHaveBeenLastCalledWith({
      environmentId: "primary",
      input: {
        patch: { issueTracking: { linear: { projectTeamsToDelete: ["project_1"] } } },
      },
    });
  });

  it("keeps a healthy single-key response from an older server usable", () => {
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Legacy account",
      accountEmail: null,
      teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
      accounts: [],
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectTeams = { project_1: "ENG" };

    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });

    expect(textContent(dialog)).toContain("Project connections");
    expect(textContent(dialog)).toContain("Engineering (ENG)");
    expect(textContent(dialog)).not.toContain("Saved API key needs attention");
  });

  it("offers environment and saved teams together", () => {
    connectionState.data = {
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Saved account",
      accountEmail: null,
      teams: [],
      accounts: [
        {
          credentialId: "saved-user",
          status: "authenticated",
          accountName: "Saved account",
          accountEmail: null,
          teams: [{ id: "team-saved", key: "SAVED", name: "Saved" }],
        },
      ],
      environmentAccount: {
        status: "authenticated",
        accountName: "Environment account",
        accountEmail: null,
        teams: [{ id: "team-env", key: "ENV", name: "Environment" }],
      },
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];

    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });

    expect(textContent(dialog)).toContain("Environment (ENV)");
    expect(textContent(dialog)).toContain("Saved (SAVED)");
  });

  it("shows and clears a project linked to an invalid environment token", async () => {
    connectionState.data = {
      status: "unverified",
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      teams: [],
      accounts: [],
      environmentAccount: {
        status: "unverified",
        accountName: "Environment account",
        accountEmail: null,
        teams: [],
      },
    };
    connectionState.error = null;
    projectsState.projects = [{ id: "project_1", title: "T3 Code", environmentId: "primary" }];
    settingsState.projectTeams = { project_1: "ENG" };
    commands.binding.mockResolvedValue(AsyncResult.success(undefined));

    hooks.beginRender();
    const dialog = LinearConnectionDialog({
      open: true,
      onOpenChange: vi.fn(),
      onProviderChanged: vi.fn(),
    });
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
      input: { projectId: "project_1", binding: null },
    });
  });

  it("removes an invalid legacy key before another key can be added", async () => {
    connectionState.data = {
      status: "unverified",
      hasStoredToken: true,
      accountName: null,
      accountEmail: null,
      teams: [],
      accounts: [],
    };
    connectionState.error = null;
    commands.disconnect.mockResolvedValue(AsyncResult.success(undefined));
    const props = { open: true, onOpenChange: vi.fn(), onProviderChanged: vi.fn() };

    hooks.beginRender();
    let dialog = LinearConnectionDialog(props);
    const input = visitElements(dialog, (element) => element.type === Input);
    (
      input?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined
    )?.({ currentTarget: { value: "new-key" } });
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const form = visitElements(dialog, (element) => element.type === "form");
    await (
      form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    )?.({ preventDefault: vi.fn() });
    expect(commands.connect).not.toHaveBeenCalled();

    const recover = visitElements(
      dialog,
      (element) =>
        element.type === Button &&
        element.props["aria-label"] === "Disconnect saved Linear API key",
    );
    (recover?.props.onClick as (() => void) | undefined)?.();
    hooks.beginRender();
    dialog = LinearConnectionDialog(props);
    const confirm = visitElements(
      dialog,
      (element) => element.type === Button && element.props.children === "Disconnect saved key",
    );
    await (confirm?.props.onClick as (() => Promise<void>) | undefined)?.();

    expect(commands.disconnect).toHaveBeenCalledWith({
      environmentId: "primary",
      input: undefined,
    });
  });
});
