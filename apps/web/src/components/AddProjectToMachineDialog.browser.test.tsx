import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const clone = vi.hoisted(() => vi.fn());
const snapshots = vi.hoisted(() => vi.fn<() => ReadonlyArray<ProjectCloneSnapshot>>());

vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: clone,
}));
vi.mock(import("../state/projectClones"), async (original) => ({
  ...(await original()),
  // Clones land on the target machine only.
  useEnvironmentProjectClones: (environmentId) =>
    environmentId === "environment-2" ? snapshots() : [],
}));

const project = vi.hoisted(() => {
  let value: unknown = null;
  const listeners = new Set<() => void>();
  return {
    // Each test starts from no project and no listeners left by an earlier test.
    setup: (initial: unknown) => {
      value = initial;
      listeners.clear();
    },
    get: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: (() => project.get()) as never,
    subscribeProject: ((_ref: unknown, listener: (value: unknown) => void) =>
      project.subscribe(() => listener(project.get()))) as never,
    useProject: (() => useSyncExternalStore(project.subscribe, project.get)) as never,
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: EnvironmentId.make("environment-2") },
      {
        environmentId: EnvironmentId.make("environment-3"),
        serverConfig: {
          environment: {
            platform: { machine: "linux" },
            capabilities: { ignoredFileListing: true, ignoredFileSearch: true },
          },
        },
      },
    ],
  })) as never,
}));
vi.mock(import("../state/projects"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  const listing = Atom.make(
    AsyncResult.success({ files: [{ path: ".env", byteLength: 12 }], truncated: true }),
  );
  return {
    ...actual,
    projectEnvironment: { ...actual.projectEnvironment, listIgnoredFiles: () => listing },
  };
});
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => () => undefined) as never,
}));
vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: () => [
    {
      environmentId: EnvironmentId.make("environment-2"),
      label: "Remote machine",
      machine: "linux",
    },
  ],
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";
import { ToastProvider } from "./ui/toast";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const nextProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-2"));
// Only environment-3 can list ignored files.
const searchableProjectRef = scopeProjectRef(
  EnvironmentId.make("environment-3"),
  ProjectId.make("project-3"),
);
const PROJECT = {
  environmentId,
  id: projectRef.projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
};

function CloneDialogWithToasts() {
  return (
    <ToastProvider>
      <ProjectCloneToastCoordinator />
      <AddProjectToMachineDialogHost />
    </ToastProvider>
  );
}

describe("AddProjectToMachineDialog", () => {
  it("keeps the replacement open after the dismissed clone finishes starting", async () => {
    project.setup(PROJECT);
    const reply = Promise.withResolvers<ProjectId>();
    const requested = Promise.withResolvers<ProjectId>();
    clone.mockImplementationOnce(({ projectId }: { projectId: ProjectId }) => {
      requested.resolve(projectId);
      return reply.promise;
    });
    snapshots.mockReturnValue([]);
    await using screen = await render(<CloneDialogWithToasts />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    const folder = screen.getByRole("textbox", { name: /^Folder on/ });
    await folder.fill("/checkout");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    const projectId = await requested.promise;
    snapshots.mockReturnValue([
      {
        projectId,
        remoteUrl: "https://example.com/repo.git",
        destinationPath: "/checkout",
        repository: null,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        error: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        sequence: 1,
      },
    ]);
    await screen.rerender(<CloneDialogWithToasts />);
    await userEvent.keyboard("{Escape}");

    await act(() => {
      project.set({ ...PROJECT, id: nextProjectRef.projectId, title: "Next repo" });
      openAddProjectToMachine({ projectRef: nextProjectRef, targetEnvironmentId: null });
    });
    await expect.element(screen.getByText(/Clone Next repo/)).toBeVisible();
    const progress = page.getByText("Cloning checkout", { exact: true });
    await expect.element(progress).not.toBeInTheDocument();
    reply.resolve(projectId);
    await expect.element(progress).toBeVisible();
    await expect.element(screen.getByText(/Clone Next repo/)).toBeVisible();
  });

  it("closes when its project goes away", async () => {
    project.setup(PROJECT);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(screen.getByText("Add to another machine")).toBeInTheDocument();

    await act(() => project.set(null));
    await act(() => project.set(PROJECT));
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("does not reopen for a project that vanished before the dialog showed", async () => {
    project.setup(PROJECT);
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
      project.set(null);
    });
    await act(() => project.set(PROJECT));

    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("clears the ignored file search on Escape before closing", async () => {
    project.setup({
      ...PROJECT,
      environmentId: searchableProjectRef.environmentId,
      id: searchableProjectRef.projectId,
    });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() =>
      openAddProjectToMachine({ projectRef: searchableProjectRef, targetEnvironmentId: null }),
    );
    const file = screen.getByRole("checkbox", { name: /\.env/ });
    await file.click();
    await expect.element(file).not.toBeChecked();
    const dialog = screen.getByRole("dialog", { name: "Add to another machine" });
    const search = screen.getByRole("searchbox", { name: "Search ignored files" });
    await search.fill("env");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(
            new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true }),
          );
      });
      await expect.element(search).toHaveValue("env");
      await expect.element(dialog).toHaveAttribute("data-open");
    }

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveAttribute("type", "text");
    await expect.element(file).not.toBeChecked();
    // Holding Escape repeats the keydown, which must not also close the dialog.
    await act(() => {
      search.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect.element(dialog).toHaveAttribute("data-open");

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  });
});
