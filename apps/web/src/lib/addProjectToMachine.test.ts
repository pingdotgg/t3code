import { EnvironmentId, ProjectId, ProjectReadFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

interface FileRequest {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents?: string;
  readonly encoding?: "utf8" | "base64";
}

// A fake pair of servers that honour `encoding` the way WorkspaceFileSystem does.
const machines = vi.hoisted(() => ({
  source: new Map<string, Uint8Array>(),
  target: new Map<string, Uint8Array>(),
  requests: [] as Array<FileRequest>,
  copyDone: () => {},
}));

function setup(files: Record<string, Uint8Array>) {
  machines.source = new Map(Object.entries(files));
  machines.target = new Map();
  machines.requests = [];
  return new Promise<void>((resolve) => {
    machines.copyDone = resolve;
  });
}

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: Cause.Cause<unknown> }) => Cause.squash(result.cause),
  executeAtomQuery: async (_registry: unknown, read: { input: FileRequest }) => {
    const { input } = read;
    machines.requests.push(input);
    const bytes = machines.source.get(input.relativePath)!;
    if (input.encoding === "base64") {
      const contents = Buffer.from(bytes).toString("base64");
      return { _tag: "Success", value: { contents, truncated: false } };
    }
    if (bytes.includes(0)) {
      const error = new ProjectReadFileError({ ...input, failure: "binary_file" });
      return { _tag: "Failure", cause: Cause.fail(error) };
    }
    const contents = new TextDecoder().decode(bytes);
    return { _tag: "Success", value: { contents, truncated: false } };
  },
  runAtomCommand: async (_registry: unknown, command: string, request: { input: FileRequest }) => {
    if (command === "startProjectClone") return { _tag: "Success", value: { cwd: "/target" } };
    const { input } = request;
    machines.requests.push(input);
    machines.target.set(
      input.relativePath,
      input.encoding === "base64"
        ? Uint8Array.from(Buffer.from(input.contents!, "base64"))
        : new TextEncoder().encode(input.contents),
    );
    // Files copy in order, and the last one is always text.
    if (input.relativePath === ".env") machines.copyDone();
    return { _tag: "Success", value: { relativePath: input.relativePath } };
  },
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: { readFile: (read: unknown) => read, writeFile: "writeFile" },
}));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { startProjectClone: "startProjectClone" },
}));
vi.mock("../state/projectClones", () => ({
  environmentProjectClonesAtom: () => "clones",
  silenceProjectCloneToasts: () => {},
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: () => () => {},
    get: () => [{ projectId: "project", phase: "done" }],
  },
}));

import { addProjectToMachine, isDefaultCopiedFile } from "./addProjectToMachine";

describe("isDefaultCopiedFile", () => {
  it("selects env files anywhere in the tree", () => {
    expect(
      [".env", "apps/web/.env.local", ".envrc", ".dev.vars", "dist.log", ".environment"].filter(
        isDefaultCopiedFile,
      ),
    ).toEqual([".env", "apps/web/.env.local", ".envrc", ".dev.vars"]);
  });
});

// NUL plus bytes that are not valid UTF-8, which a text read would replace.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe, 0x80]);
const ENV = new TextEncoder().encode("TOKEN=secret\n");

const copy = (base64: boolean) =>
  addProjectToMachine({
    source: { environmentId: EnvironmentId.make("source"), cwd: "/source" },
    subdirectory: "",
    target: { environmentId: EnvironmentId.make("target"), label: "Laptop" },
    projectId: ProjectId.make("project"),
    title: "Project",
    remoteUrl: "git@github.com:pingdotgg/t3code.git",
    destinationPath: "/target",
    files: ["logo.png", ".env"],
    base64,
  });

describe("addProjectToMachine", () => {
  it("copies binary files byte for byte when both servers take base64", async () => {
    const copyDone = setup({ "logo.png": PNG, ".env": ENV });
    await copy(true);
    await copyDone;

    expect(machines.target).toEqual(
      new Map([
        ["logo.png", PNG],
        [".env", ENV],
      ]),
    );
    expect(machines.requests.every((request) => request.encoding === "base64")).toBe(true);
  });

  it("copies text files and leaves the encoding out for older servers", async () => {
    const copyDone = setup({ "logo.png": PNG, ".env": ENV });
    await copy(false);
    await copyDone;

    expect(machines.target).toEqual(new Map([[".env", ENV]]));
    expect(machines.requests.some((request) => "encoding" in request)).toBe(false);
  });
});
