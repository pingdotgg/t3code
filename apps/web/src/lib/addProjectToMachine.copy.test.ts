import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  executeAtomQuery: vi.fn(),
  runAtomCommand: vi.fn(),
  readProject: vi.fn(),
  startProjectClone: Symbol("start-project-clone"),
  writeFile: Symbol("write-file"),
}));

const clonesAtom = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]);

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../state/projectClones", () => ({
  environmentProjectClonesAtom: () => clonesAtom,
  silenceProjectCloneToasts: () => undefined,
}));

vi.mock("../state/projects", () => ({
  projectEnvironment: { readFile: (args: unknown) => args, writeFile: mocks.writeFile },
}));

vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { startProjectClone: mocks.startProjectClone },
}));

vi.mock("../state/entities", () => ({ readProject: mocks.readProject }));

import { addProjectToMachine } from "./addProjectToMachine";

const environmentId = EnvironmentId.make("target");
const projectId = ProjectId.make("project-1");

const startInput = {
  source: { environmentId: EnvironmentId.make("source"), cwd: "/src/app" },
  subdirectory: "",
  target: { environmentId, label: "Laptop" },
  projectId,
  title: "app",
  remoteUrl: "git@github.com:acme/app.git",
  destinationPath: "/work/app",
};

function runningClone(): ProjectCloneSnapshot {
  return {
    projectId,
    remoteUrl: "git@github.com:acme/app.git",
    destinationPath: "/work/app",
    repository: null,
    phase: "running",
    stage: "receiving",
    percent: 40,
    detail: null,
    error: null,
    startedAt: "2026-10-20T00:00:00.000Z",
    endedAt: null,
    sequence: 1,
  };
}

describe("addProjectToMachine", () => {
  it("still copies files when the finished clone's record expired before the client saw it", async () => {
    let wrote: (input: unknown) => void = () => undefined;
    const written = new Promise((resolve) => {
      wrote = resolve;
    });
    mocks.executeAtomQuery.mockResolvedValue({
      _tag: "Success",
      value: { contents: "KEY=value\n", truncated: false },
    });
    mocks.runAtomCommand.mockImplementation(async (_registry, command, args) => {
      if (command === mocks.startProjectClone) {
        return { _tag: "Success", value: { cwd: "/work/app" } };
      }
      if (command === mocks.writeFile) wrote(args);
      return { _tag: "Success", value: undefined };
    });
    mocks.readProject.mockReturnValue({ id: projectId });

    await addProjectToMachine({ ...startInput, files: [".env.local"] });
    appAtomRegistry.set(clonesAtom, [runningClone()]);
    // A reconnect after the server's retention window lists no record at all.
    appAtomRegistry.set(clonesAtom, []);

    await expect(written).resolves.toMatchObject({
      environmentId,
      input: { cwd: "/work/app", relativePath: ".env.local", contents: "KEY=value\n" },
    });
  });

  it("refuses to copy a file the server could not decode as UTF-8", async () => {
    const writes: Array<unknown> = [];
    let wroteLast: () => void = () => undefined;
    const lastWritten = new Promise<void>((resolve) => {
      wroteLast = resolve;
    });
    mocks.executeAtomQuery.mockImplementation(
      async (_registry, query: { readonly input: { readonly relativePath: string } }) => ({
        _tag: "Success",
        // `NAME=caf\xe9` read from a Latin-1 file comes back with U+FFFD.
        value: {
          contents: query.input.relativePath === ".env.latin1" ? "NAME=caf\uFFFD\n" : "KEY=value\n",
          truncated: false,
        },
      }),
    );
    mocks.runAtomCommand.mockImplementation(async (_registry, command, args) => {
      if (command === mocks.startProjectClone) {
        return { _tag: "Success", value: { cwd: "/work/app" } };
      }
      if (command === mocks.writeFile) {
        writes.push(args);
        wroteLast();
      }
      return { _tag: "Success", value: undefined };
    });

    await addProjectToMachine({ ...startInput, files: [".env.latin1", ".env"] });
    appAtomRegistry.set(clonesAtom, [{ ...runningClone(), phase: "done" }]);
    await lastWritten;

    expect(writes).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ relativePath: ".env" }) }),
    ]);
  });
});
