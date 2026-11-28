import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const runAtomCommandMock = vi.hoisted(() => vi.fn());
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: runAtomCommandMock,
}));

import { useDraftSendOnOpenStore } from "~/draftSendOnOpenStore";
import { createScratchProjectActions } from "./useScratchProject";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(environmentId: EnvironmentId, scratchWorkspaceRoot: string | null) {
  return {
    environmentId,
    connection: { phase: "connected" },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });
});

describe("startScratchThread", () => {
  it("ignores repeat starts while one is pending and allows retry after failure", async () => {
    runAtomCommandMock.mockReset();
    let resolveOpen!: (value: unknown) => void;
    runAtomCommandMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOpen = resolve;
          }),
      )
      .mockResolvedValueOnce(Exit.succeed({ environmentId: local, id: "scratch-1" as ProjectId }));
    const handleNewThread = vi.fn(async () => null);
    const scratch = createScratchProjectActions({
      environments: () => [scratchEnvironment(local, "/local/scratch")],
      primaryEnvironmentId: () => local,
      registry: AtomRegistry.make(),
      handleNewThread,
    });

    const first = scratch.startScratchThread(local, { sendCarriedDraft: true });
    const duplicate = scratch.startScratchThread(local, { sendCarriedDraft: true });
    await duplicate;
    expect(runAtomCommandMock).toHaveBeenCalledTimes(1);

    resolveOpen(Exit.fail("boom"));
    await first;
    expect(handleNewThread).not.toHaveBeenCalled();

    await scratch.startScratchThread(local, { sendCarriedDraft: true });
    expect(runAtomCommandMock).toHaveBeenCalledTimes(2);
    expect(handleNewThread).toHaveBeenCalledTimes(1);
  });

  it("disarms send-on-open when creating the scratch thread fails", async () => {
    runAtomCommandMock.mockReset();
    useDraftSendOnOpenStore.setState({ armed: false, draftId: null });
    runAtomCommandMock.mockResolvedValueOnce(
      Exit.succeed({ environmentId: local, id: "scratch-2" as ProjectId }),
    );
    const scratch = createScratchProjectActions({
      environments: () => [scratchEnvironment(local, "/local/scratch")],
      primaryEnvironmentId: () => local,
      registry: AtomRegistry.make(),
      handleNewThread: async () => {
        throw new Error("thread creation failed");
      },
    });

    await scratch.startScratchThread(local, { sendCarriedDraft: true });
    expect(useDraftSendOnOpenStore.getState().armed).toBe(false);
    expect(useDraftSendOnOpenStore.getState().draftId).toBeNull();
  });
});
