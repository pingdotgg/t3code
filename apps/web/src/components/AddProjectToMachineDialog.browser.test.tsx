import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type ProjectListIgnoredFilesInput,
  type ProjectListIgnoredFilesResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import type { AddProjectToMachineInput } from "../lib/addProjectToMachine";

type Listing = AsyncResult.AsyncResult<ProjectListIgnoredFilesResult>;
const mocks = vi.hoisted(() => ({
  listIgnoredFiles:
    vi.fn<(target: { input: ProjectListIgnoredFilesInput }) => Atom.Writable<Listing>>(),
  addProject: vi.fn<(input: AddProjectToMachineInput) => Promise<void>>(),
  newThread: vi.fn(),
}));

vi.mock("../state/entities", () => ({ useProject: () => project }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [source, target] }),
}));
vi.mock("../hooks/useAddProjectTargets", () => ({
  useAddProjectTargets: () => [{ ...target, machine: "server" }],
}));
vi.mock("../hooks/useLogicalProjectEnvironments", () => ({
  useLogicalProjectEnvironments: () => [],
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.newThread }));
vi.mock("../state/queries", () => ({ useDebouncedValue: <A,>(value: A) => value }));
vi.mock("../state/projects", () => ({
  projectEnvironment: { listIgnoredFiles: mocks.listIgnoredFiles },
}));
vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: mocks.addProject,
}));

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

const source = {
  environmentId: EnvironmentId.make("source"),
  label: "Source",
  serverConfig: {
    environment: {
      platform: { machine: "server" },
      capabilities: { ignoredFileListing: true, ignoredFileBrowsing: true },
    },
  },
};
const target = {
  environmentId: EnvironmentId.make("target"),
  label: "Target",
  serverConfig: { settings: { addProjectBaseDirectory: "/clones" } },
};
const project = {
  id: ProjectId.make("project"),
  environmentId: source.environmentId,
  title: "Project",
  workspaceRoot: "/project",
};
const defaultFiles = [
  { path: ".env", byteLength: 12 },
  { path: "notes.txt", byteLength: 4 },
];

function setup(initial: Listing = AsyncResult.initial(true)) {
  const registry = AtomRegistry.make();
  const defaults = Atom.make(initial);
  const search = Atom.make<Listing>(
    AsyncResult.success({ files: [defaultFiles[1]!], truncated: false }),
  );
  mocks.listIgnoredFiles
    .mockReset()
    .mockImplementation(({ input }) => (input.query ? search : defaults));
  mocks.addProject.mockReset().mockResolvedValue(undefined);
  mocks.newThread.mockReset();
  openAddProjectToMachine({
    projectRef: { environmentId: project.environmentId, projectId: project.id },
    targetEnvironmentId: target.environmentId,
  });
  return {
    defaults,
    registry,
    dialog: () => (
      <RegistryContext.Provider value={registry}>
        <AddProjectToMachineDialogHost />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

const button = (name: string) => page.getByRole("button", { name, exact: true });
const checkbox = (name: string) =>
  page.getByRole("checkbox", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });

describe("ignored-file picker query state", () => {
  it("waits for defaults before search edits and preserves an intentional clear", async () => {
    using state = setup();
    await using _screen = await render(state.dialog());
    const search = page.getByRole("textbox", { name: "Search ignored files" });
    await act(() => search.element().focus());
    await userEvent.keyboard("notes");

    await expect.element(search).toHaveValue("");
    await expect.element(checkbox("notes.txt")).not.toBeInTheDocument();
    await expect.element(button("Clone to Target")).toBeDisabled();

    await act(() =>
      state.registry.set(
        state.defaults,
        AsyncResult.success({ files: defaultFiles, truncated: false }),
      ),
    );
    await expect.element(checkbox(".env")).toBeChecked();
    await expect.element(button("Clone to Target")).toBeEnabled();

    await userEvent.fill(search, "notes");
    await userEvent.click(checkbox("notes.txt"));
    await userEvent.fill(search, "");
    await expect.element(checkbox(".env")).toBeChecked();
    await expect.element(checkbox("notes.txt")).toBeChecked();

    await userEvent.click(button("Clear listed"));
    await act(() =>
      state.registry.set(
        state.defaults,
        AsyncResult.success({ files: [...defaultFiles], truncated: false }),
      ),
    );
    await userEvent.fill(search, "notes");
    await expect.element(checkbox("notes.txt")).not.toBeChecked();
    await userEvent.fill(search, "");
    await expect.element(checkbox(".env")).not.toBeChecked();
    await userEvent.click(button("Clone to Target"));
    expect(mocks.addProject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ files: [] }),
    );
  });

  it("keeps cached rows selectable while a refresh blocks page navigation", async () => {
    const listing = {
      files: Array.from({ length: 200 }, (_, index) => ({
        path: `file-${index}.txt`,
        byteLength: 4,
      })),
      truncated: true,
      nextCursor: "file-199.txt",
    };
    using state = setup(AsyncResult.success(listing));
    await using _screen = await render(state.dialog());
    await expect.element(checkbox("file-0.txt")).toBeVisible();
    await expect.element(button("Next")).toBeEnabled();

    await act(() =>
      state.registry.set(state.defaults, AsyncResult.success(listing, { waiting: true })),
    );
    await expect.element(page.getByText("200 listed on this page", { exact: true })).toBeVisible();
    await expect.element(checkbox("file-0.txt")).toBeVisible();
    await expect.element(checkbox("file-199.txt")).toBeInTheDocument();
    await expect.element(button("Next")).toBeDisabled();
    await expect
      .element(page.getByText("Finding ignored files…", { exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(checkbox("file-0.txt"));
    await expect.element(checkbox("file-0.txt")).toBeChecked();

    await act(() => state.registry.set(state.defaults, AsyncResult.success(listing)));
    await expect.element(button("Next")).toBeEnabled();
    await expect.element(checkbox("file-0.txt")).toBeChecked();
    await userEvent.click(button("Clone to Target"));
    expect(mocks.addProject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ files: ["file-0.txt"] }),
    );
  });
});
