import {
  EnvironmentId,
  type SidebarStateMutation,
  type SidebarStateSnapshot,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchReorderPinnedThreads,
  dispatchSetThreadPinned,
  registerSidebarStateClient,
} from "./sidebarStateSync";

const environmentId = EnvironmentId.make("env");
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe("sidebarStateSync", () => {
  it("flushes pin mutations queued before the primary connection is ready", async () => {
    dispatchSetThreadPinned("project", "env:thread", true);
    const updateState = vi.fn(async () => ({
      revision: 1,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    }));
    const registration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot: vi.fn(),
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = registration.dispose;

    await vi.waitFor(() =>
      expect(updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationId: expect.any(String),
          type: "set-pinned",
          projectKey: "project",
          threadKey: "env:thread",
          pinned: true,
        }),
      ),
    );
  });

  it("imports legacy profile pins only into an empty shared state", async () => {
    const applySnapshot = vi.fn();
    const updateState = vi.fn(async () => ({
      revision: 1,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    }));
    const registration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot,
      readLegacyPins: () => ({ project: ["env:thread"] }),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = registration.dispose;

    registration.handleSnapshot({ revision: 0, pinnedThreadKeysByProjectKey: {} });

    await vi.waitFor(() =>
      expect(updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationId: expect.any(String),
          type: "import-pins",
          pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(applySnapshot).toHaveBeenCalledWith({
        revision: 1,
        pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
      }),
    );
  });

  it("applies the newest streamed revision after queued optimistic writes settle", async () => {
    let resolveUpdate: ((snapshot: SidebarStateSnapshot) => void) | undefined;
    const updateState = vi.fn(
      () =>
        new Promise<SidebarStateSnapshot>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const applySnapshot = vi.fn();
    const registration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot,
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = registration.dispose;

    registration.handleSnapshot({ revision: 1, pinnedThreadKeysByProjectKey: {} });
    dispatchSetThreadPinned("project", "env:thread", true);
    await vi.waitFor(() => expect(updateState).toHaveBeenCalledOnce());
    registration.handleSnapshot({
      revision: 3,
      pinnedThreadKeysByProjectKey: { project: ["env:other"] },
    });
    resolveUpdate?.({
      revision: 2,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    });

    await vi.waitFor(() =>
      expect(applySnapshot).toHaveBeenLastCalledWith({
        revision: 3,
        pinnedThreadKeysByProjectKey: { project: ["env:other"] },
      }),
    );
  });

  it("does not apply late mutation responses from a superseded connection", async () => {
    let resolveUpdate: ((snapshot: SidebarStateSnapshot) => void) | undefined;
    const updateState = new Promise<SidebarStateSnapshot>((resolve) => {
      resolveUpdate = resolve;
    });
    const applyOldSnapshot = vi.fn();
    const oldRegistration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState: () => updateState,
      applySnapshot: applyOldSnapshot,
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    oldRegistration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });
    applyOldSnapshot.mockClear();

    dispatchSetThreadPinned("project", "env:thread", true);
    oldRegistration.dispose();

    const applyCurrentSnapshot = vi.fn();
    const currentRegistration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState: vi.fn(),
      applySnapshot: applyCurrentSnapshot,
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = currentRegistration.dispose;
    const currentSnapshot = {
      revision: 2,
      pinnedThreadKeysByProjectKey: { project: ["env:other"] },
    } satisfies SidebarStateSnapshot;
    currentRegistration.handleSnapshot(currentSnapshot);

    resolveUpdate?.({
      revision: 1,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    });
    await updateState;
    await vi.waitFor(() => expect(applyCurrentSnapshot).toHaveBeenCalledWith(currentSnapshot));

    expect(applyOldSnapshot).not.toHaveBeenCalled();
    expect(applyCurrentSnapshot).toHaveBeenLastCalledWith(currentSnapshot);
  });

  it("retries a transport-failed mutation through the replacement primary client", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mutation = {
      type: "set-pinned",
      projectKey: "project",
      threadKey: "env:thread",
      pinned: true,
    } as const;
    const getOldState = vi.fn();
    let rejectUpdate: ((error: Error) => void) | undefined;
    const failedUpdate = new Promise<SidebarStateSnapshot>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    let attemptedMutationId: string | undefined;
    const oldUpdateState = vi.fn((input: SidebarStateMutation) => {
      attemptedMutationId = input.mutationId;
      return failedUpdate;
    });
    const oldRegistration = registerSidebarStateClient({
      environmentId,
      getState: getOldState,
      updateState: oldUpdateState,
      applySnapshot: vi.fn(),
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    oldRegistration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });

    dispatchSetThreadPinned(mutation.projectKey, mutation.threadKey, mutation.pinned);
    await vi.waitFor(() => expect(oldUpdateState).toHaveBeenCalledOnce());
    oldRegistration.dispose();

    const retriedSnapshot = {
      revision: 1,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    } satisfies SidebarStateSnapshot;
    let retriedMutationId: string | undefined;
    const updateState = vi.fn(async (input: SidebarStateMutation) => {
      retriedMutationId = input.mutationId;
      return retriedSnapshot;
    });
    const applySnapshot = vi.fn();
    const replacementRegistration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot,
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = replacementRegistration.dispose;

    rejectUpdate?.(new Error("SocketCloseError: connection lost"));
    await expect(failedUpdate).rejects.toThrow("SocketCloseError");
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled);
    await vi.waitFor(() =>
      expect(updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationId: expect.any(String),
          ...mutation,
        }),
      ),
    );
    await vi.waitFor(() => expect(applySnapshot).toHaveBeenLastCalledWith(retriedSnapshot));
    expect(retriedMutationId).toBe(attemptedMutationId);
    expect(getOldState).not.toHaveBeenCalled();
  });

  it("retries a transport-failed mutation after the current client resubscribes", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attemptedMutationIds: string[] = [];
    const retriedSnapshot = {
      revision: 1,
      pinnedThreadKeysByProjectKey: { project: ["env:thread"] },
    } satisfies SidebarStateSnapshot;
    const updateState = vi.fn(async (input: SidebarStateMutation) => {
      attemptedMutationIds.push(input.mutationId);
      if (attemptedMutationIds.length === 1) {
        throw new Error("SocketCloseError: connection lost");
      }
      return retriedSnapshot;
    });
    const applySnapshot = vi.fn();
    const registration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot,
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = registration.dispose;
    registration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });

    dispatchSetThreadPinned("project", "env:thread", true);
    await vi.waitFor(() => expect(updateState).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled);

    registration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });

    await vi.waitFor(() => expect(updateState).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(applySnapshot).toHaveBeenLastCalledWith(retriedSnapshot));
    expect(new Set(attemptedMutationIds).size).toBe(1);
  });

  it("preserves queued mutation order after a transport failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attemptedMutations: SidebarStateMutation[] = [];
    const oldUpdateState = vi.fn(async (input: SidebarStateMutation) => {
      attemptedMutations.push(input);
      throw new Error("SocketCloseError: connection lost");
    });
    const oldRegistration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState: oldUpdateState,
      applySnapshot: vi.fn(),
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    oldRegistration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });

    dispatchSetThreadPinned("project", "env:thread", true);
    dispatchReorderPinnedThreads("project", "env:thread", "env:other");
    await vi.waitFor(() => expect(attemptedMutations).toHaveLength(1));
    oldRegistration.dispose();

    const replayedMutations: SidebarStateMutation[] = [];
    const replacementRegistration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState: vi.fn(async (input: SidebarStateMutation) => {
        replayedMutations.push(input);
        return {
          revision: replayedMutations.length,
          pinnedThreadKeysByProjectKey: { project: ["env:thread", "env:other"] },
        };
      }),
      applySnapshot: vi.fn(),
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = replacementRegistration.dispose;

    await vi.waitFor(() => expect(replayedMutations).toHaveLength(2));
    expect(replayedMutations.map(({ type }) => type)).toEqual(["set-pinned", "reorder-pinned"]);
  });

  it("does not let queued mutations jump ahead when a snapshot races a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectFirstUpdate: ((error: Error) => void) | undefined;
    const firstUpdate = new Promise<SidebarStateSnapshot>((_resolve, reject) => {
      rejectFirstUpdate = reject;
    });
    const attemptedMutations: SidebarStateMutation[] = [];
    const updateState = vi.fn((input: SidebarStateMutation) => {
      attemptedMutations.push(input);
      if (attemptedMutations.length === 1) {
        return firstUpdate;
      }
      return Promise.resolve({
        revision: attemptedMutations.length - 1,
        pinnedThreadKeysByProjectKey: { project: ["env:thread", "env:other"] },
      });
    });
    const registration = registerSidebarStateClient({
      environmentId,
      getState: vi.fn(),
      updateState,
      applySnapshot: vi.fn(),
      readLegacyPins: () => ({}),
      markLegacyPinsMigrated: vi.fn(),
    });
    dispose = registration.dispose;
    registration.handleSnapshot({
      revision: 0,
      pinnedThreadKeysByProjectKey: {},
    });

    dispatchSetThreadPinned("project", "env:thread", true);
    dispatchReorderPinnedThreads("project", "env:thread", "env:other");
    await vi.waitFor(() => expect(attemptedMutations).toHaveLength(1));

    registration.handleSnapshot({
      revision: 1,
      pinnedThreadKeysByProjectKey: {},
    });
    rejectFirstUpdate?.(new Error("SocketCloseError: connection lost"));
    await expect(firstUpdate).rejects.toThrow("SocketCloseError");

    await vi.waitFor(() => expect(attemptedMutations).toHaveLength(3));
    expect(attemptedMutations.map(({ type }) => type)).toEqual([
      "set-pinned",
      "set-pinned",
      "reorder-pinned",
    ]);
    expect(attemptedMutations[1]?.mutationId).toBe(attemptedMutations[0]?.mutationId);
  });
});
