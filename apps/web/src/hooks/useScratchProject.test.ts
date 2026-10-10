import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  openScratch: vi.fn(),
  newThread: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.openScratch }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: state.toast },
}));

import { useScratchProject } from "./useScratchProject";

const environmentId = EnvironmentId.make("remote-environment");
const projectId = ProjectId.make("scratch-project");
const success = { _tag: "Success", value: { environmentId, id: projectId } };

beforeEach(() => {
  vi.resetAllMocks();
  state.newThread.mockResolvedValue({ draftId: "fresh-draft", threadId: "fresh-thread" });
});

describe("startScratchThread", () => {
  it("opens a scratch composer on the requested environment", async () => {
    state.openScratch.mockResolvedValue(success);
    expect(await useScratchProject().startScratchThread(environmentId)).toBe(true);
    expect(state.newThread).toHaveBeenCalledWith({ environmentId, projectId });
  });

  it("does not navigate when the user moves on during the scratch RPC", async () => {
    let resolveProjectOpen: (result: typeof success) => void = () => undefined;
    const pending = new Promise<typeof success>((resolve) => {
      resolveProjectOpen = resolve;
    });
    state.openScratch.mockReturnValue(pending);
    let stillCurrent = true;
    const start = useScratchProject().startScratchThread(environmentId, () => stillCurrent);
    stillCurrent = false;
    resolveProjectOpen(success);
    expect(await start).toBe(false);
    expect(state.newThread).not.toHaveBeenCalled();
  });

  it("does not open a project when the sending composer is already stale", async () => {
    expect(await useScratchProject().startScratchThread(environmentId, () => false)).toBe(false);
    expect(state.openScratch).not.toHaveBeenCalled();
  });

  it("reports failure to open the composer without claiming it opened", async () => {
    state.openScratch.mockResolvedValue(success);
    state.newThread.mockRejectedValue(new Error("Disconnected"));
    expect(await useScratchProject().startScratchThread(environmentId)).toBe(false);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not start without a project",
        description: "Disconnected",
      }),
    );
  });
});
