import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type DraftId } from "../composerDraftStore";
import { useScratchDraftEnvironment } from "./useScratchDraftEnvironment";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  remap: vi.fn(),
  context: vi.fn(),
  getDraft: vi.fn(),
}));
vi.mock("./useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: state.open }),
}));
const GROUPING_SETTINGS = {};
vi.mock("./useSettings", () => ({ useClientSettings: () => GROUPING_SETTINGS }));
vi.mock("../logicalProject", () => ({
  selectProjectGroupingSettings: vi.fn(),
  deriveLogicalProjectKeyFromSettings: (project: EnvironmentProject) =>
    `${project.environmentId}:${project.id}`,
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftSession: state.getDraft,
      setLogicalProjectDraftThreadId: state.remap,
      setDraftThreadContext: state.context,
    }),
  },
}));
const ENVIRONMENTS = [
  {
    environmentId: "a",
    label: "A",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/a" },
  },
  {
    environmentId: "b",
    label: "B",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/b" },
  },
  {
    environmentId: "c",
    label: "C",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/c" },
  },
  {
    environmentId: "offline",
    label: "Offline",
    connection: { phase: "disconnected" },
    serverConfig: {
      environment: { platform: "linux" },
      scratchWorkspaceRoot: "/scratch/offline",
    },
  },
  {
    environmentId: "unsupported",
    label: "Unsupported",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: "linux" } },
  },
];
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "a",
  useEnvironments: () => ({ environments: ENVIRONMENTS }),
}));
const project = (id: string) =>
  ({
    id: ProjectId.make(`project-${id}`),
    environmentId: EnvironmentId.make(id),
    workspaceRoot: `/scratch/${id}`,
  }) as EnvironmentProject;
const draftId = "draft" as DraftId;
let result: ReturnType<typeof useScratchDraftEnvironment>;
let renderer: ReactTestRenderer;
let canSwitch = true;
const readCanSwitch = () => canSwitch;
const PROJECT_A = project("a");
function Probe({ activeProject = PROJECT_A }: { activeProject?: EnvironmentProject }) {
  const selection = useScratchDraftEnvironment({
    draftId,
    activeProject,
    canSwitch: readCanSwitch,
  });
  useLayoutEffect(() => {
    result = selection;
  });
  return null;
}
function deferred() {
  let resolve!: (project: EnvironmentProject | null) => void;
  const promise = new Promise<EnvironmentProject | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const select = (id: string) => {
  let promise!: Promise<void>;
  act(() => {
    promise = result.selectEnvironment(EnvironmentId.make(id));
  });
  return promise;
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  canSwitch = true;
  state.getDraft.mockReturnValue({ environmentId: "a", projectId: "project-a", promotedTo: null });
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => act(() => renderer.unmount()));

describe("projectless machine selection", () => {
  it("offers connected machines before they have scratch projects and keeps the initial target", () => {
    expect(result.availableEnvironments.map((env) => env.environmentId)).toEqual(["a", "b", "c"]);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.remap).not.toHaveBeenCalled();
  });
  it("keeps the same result between renders while nothing changes", () => {
    const first = result;
    act(() => renderer.update(<Probe />));
    expect(result).toBe(first);
  });
  it("retargets only for the latest selection", async () => {
    const b = deferred();
    const c = deferred();
    state.open.mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
    const toB = select("b");
    expect(result.pending).toBe(true);
    const toC = select("c");
    expect(state.open.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);
    await act(async () => {
      b.resolve(project("b"));
      await toB;
    });
    expect(state.remap).not.toHaveBeenCalled();
    expect(result.pending).toBe(true);
    await act(async () => {
      c.resolve(project("c"));
      await toC;
    });
    expect(state.remap).toHaveBeenCalledWith(
      "c:project-c",
      { environmentId: "c", projectId: "project-c" },
      draftId,
    );
    expect(result.pending).toBe(false);
  });
  it("cancels a pending switch when the current machine is picked again", async () => {
    const next = deferred();
    state.open.mockReturnValue(next.promise);
    const toB = select("b");
    await select("a");
    expect(result.pending).toBe(false);
    await act(async () => {
      next.resolve(project("b"));
      await toB;
    });
    expect(state.remap).not.toHaveBeenCalled();
  });
  it.each([
    ["the draft moved to another project", { projectId: "chosen-project" }],
    ["the draft was sent", { promotedTo: "thread-1" }],
  ])("does not retarget when %s while the machine was prepared", async (_label, change) => {
    const next = deferred();
    state.open.mockReturnValue(next.promise);
    const toB = select("b");
    state.getDraft.mockReturnValue({
      environmentId: "a",
      projectId: "project-a",
      promotedTo: null,
      ...change,
    });
    await act(async () => {
      next.resolve(project("b"));
      await toB;
    });
    expect(state.remap).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
  });
  it("keeps the draft on its machine after a failed resolution", async () => {
    state.open.mockResolvedValue(null);
    await act(async () => select("b"));
    expect(state.remap).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
  });
  it("ignores switching once sending starts", async () => {
    canSwitch = false;
    await act(async () => select("b"));
    expect(state.open).not.toHaveBeenCalled();
  });
});
