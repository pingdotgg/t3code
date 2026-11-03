import type { StateCreator } from "zustand/vanilla";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  readProjectFilesToCopy: vi.fn(),
  getClones: vi.fn(),
  onStoreChange: vi.fn(),
  resetStore: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { error: Error }) => result.error,
}));
vi.mock("zustand", async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    create: <T>(initial: StateCreator<T>) => {
      const store = createStore(initial);
      mocks.resetStore.mockImplementation(() => store.setState(store.getInitialState(), true));
      store.subscribe((state) => mocks.onStoreChange(state));
      return Object.assign((select: (state: T) => unknown) => select(store.getState()), store);
    },
  };
});
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { subscribe: () => () => {}, get: mocks.getClones },
}));
vi.mock("../components/sourceControlAppAccessToast", () => ({
  suggestAppAccessForRemote: async () => {},
}));
vi.mock("../state/projectClones", () => ({
  environmentProjectClonesAtom: () => "clones",
  silenceProjectCloneToasts: () => {},
}));
vi.mock("../state/projects", () => ({ projectEnvironment: { writeFile: "write" } }));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { startProjectClone: "clone" },
}));
vi.mock("./readProjectFilesToCopy", () => ({
  readProjectFilesToCopy: mocks.readProjectFilesToCopy,
}));

import { addProjectToMachine, useProjectFileCopy } from "./addProjectToMachine";

function setup(sourceMode: number | undefined, destinationMode: number | undefined) {
  mocks.onStoreChange.mockReset();
  mocks.resetStore();
  mocks.runAtomCommand.mockReset();
  mocks.readProjectFilesToCopy.mockReset();
  mocks.getClones.mockReset();
  const projectId = ProjectId.make("copied-project");
  const target = { environmentId: EnvironmentId.make("target"), label: "Other machine" };
  mocks.getClones.mockReturnValue([{ projectId, phase: "done" }]);
  mocks.readProjectFilesToCopy.mockResolvedValue([
    { relativePath: ".env", contents: "TOKEN=example\n", mode: sourceMode },
  ]);
  mocks.runAtomCommand
    .mockResolvedValueOnce({ _tag: "Success", value: { cwd: "/destination" } })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { relativePath: ".env", mode: destinationMode },
    });
  let markSettled = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  mocks.onStoreChange.mockImplementation((state: { copies: Record<string, { phase: string }> }) => {
    if (!Object.values(state.copies).some((copy) => copy.phase === "copying")) markSettled();
  });
  return { projectId, target, settled };
}

it.each([
  { name: "preserved", sourceMode: 0o600, destinationMode: 0o600, failed: false },
  { name: "broadened", sourceMode: 0o600, destinationMode: 0o644, failed: true },
  { name: "unsupported", sourceMode: 0o600, destinationMode: undefined, failed: true },
  {
    name: "unavailable from the source",
    sourceMode: undefined,
    destinationMode: undefined,
    failed: false,
  },
])(
  "finishes config-file copying with permissions $name",
  async ({ sourceMode, destinationMode, failed }) => {
    const { projectId, target, settled } = setup(sourceMode, destinationMode);
    await addProjectToMachine({
      source: { environmentId: EnvironmentId.make("source"), cwd: "/source" },
      subdirectory: "",
      target,
      projectId,
      title: "Copied project",
      remoteUrl: "https://github.com/example/project.git",
      destinationPath: "/destination",
      files: [".env"],
    });
    await settled;
    expect(useProjectFileCopy({ environmentId: target.environmentId, projectId })).toEqual(
      failed
        ? {
            phase: "failed",
            title: "Could not copy 1 file to Other machine",
            failures: [".env: The destination could not preserve file permissions."],
          }
        : null,
    );
  },
);
