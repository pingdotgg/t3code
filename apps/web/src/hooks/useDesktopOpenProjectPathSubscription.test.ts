import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import type { OpenProjectByPathInput } from "../lib/openProjectByPath";
import {
  runDesktopOpenProjectPathHandler,
  type DesktopOpenProjectPathHandlerDeps,
} from "./useDesktopOpenProjectPathSubscription";

const ENV = EnvironmentId.make("environment-local");

function makeDeps(overrides: Partial<DesktopOpenProjectPathHandlerDeps> = {}): {
  deps: DesktopOpenProjectPathHandlerDeps;
  readPrimaryEnvironmentId: ReturnType<typeof vi.fn>;
  ensureBootstrapped: ReturnType<typeof vi.fn>;
  readApi: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  handleNewThread: ReturnType<typeof vi.fn>;
} {
  const readPrimaryEnvironmentId = vi.fn(() => ENV);
  const ensureBootstrapped = vi.fn(async () => undefined);
  const readApi = vi.fn(() => ({ orchestration: { dispatchCommand: vi.fn() } }));
  const dispatch = vi.fn(async () => undefined);
  const toast = vi.fn();
  const navigate = vi.fn(async () => undefined);
  const handleNewThread = vi.fn(async () => undefined);

  const baseDeps: DesktopOpenProjectPathHandlerDeps = {
    path: "/tmp/project-sample",
    isDisposed: () => false,
    sidebarThreadSortOrder: "updated_at",
    defaultThreadEnvMode: "local",
    navigate: navigate as unknown as OpenProjectByPathInput["navigate"],
    handleNewThread,
    readPrimaryEnvironmentId,
    ensureBootstrapped,
    readApi: readApi as unknown as NonNullable<DesktopOpenProjectPathHandlerDeps["readApi"]>,
    dispatch,
    toast,
  };
  const deps: DesktopOpenProjectPathHandlerDeps = { ...baseDeps, ...overrides };

  return {
    deps,
    readPrimaryEnvironmentId,
    ensureBootstrapped,
    readApi,
    dispatch,
    toast,
    navigate,
    handleNewThread,
  };
}

describe("runDesktopOpenProjectPathHandler", () => {
  it("awaits bootstrap before calling dispatch", async () => {
    const order: string[] = [];
    const ensureBootstrapped = vi.fn(async () => {
      order.push("bootstrap");
    });
    const dispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    const { deps } = makeDeps({ ensureBootstrapped, dispatch });

    await runDesktopOpenProjectPathHandler(deps);

    expect(order).toEqual(["bootstrap", "dispatch"]);
  });

  it("passes the canonical input shape to dispatch", async () => {
    const { deps, dispatch } = makeDeps();

    await runDesktopOpenProjectPathHandler(deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [input] = dispatch.mock.calls[0] as [OpenProjectByPathInput];
    expect(input.environmentId).toBe(ENV);
    expect(input.path).toBe("/tmp/project-sample");
    expect(input.projects).toEqual([]);
    expect(input.threads).toEqual([]);
    expect(input.sidebarThreadSortOrder).toBe("updated_at");
    expect(input.defaultThreadEnvMode).toBe("local");
    expect(typeof input.onError).toBe("function");
  });

  it("reads a fresh project snapshot after bootstrap before dispatching", async () => {
    const order: string[] = [];
    const staleProject = { cwd: "/tmp/stale" };
    const freshProject = { cwd: "/tmp/project-sample" };
    const ensureBootstrapped = vi.fn(async () => {
      order.push("bootstrap");
    });
    const readProjectSnapshot = vi.fn(() => {
      order.push("snapshot");
      return {
        projects: [freshProject],
        threads: [],
      } as unknown as Pick<OpenProjectByPathInput, "projects" | "threads">;
    });
    const dispatch = vi.fn(async (input: OpenProjectByPathInput) => {
      order.push("dispatch");
      expect(input.projects).toEqual([freshProject]);
      expect(input.projects).not.toEqual([staleProject]);
    });
    const { deps } = makeDeps({
      ensureBootstrapped,
      readProjectSnapshot,
      dispatch,
    });

    await runDesktopOpenProjectPathHandler(deps);

    expect(order).toEqual(["bootstrap", "snapshot", "dispatch"]);
    expect(readProjectSnapshot).toHaveBeenCalledWith(ENV);
  });

  it("bails without calling dispatch if the primary environment is unknown", async () => {
    const { deps, dispatch, ensureBootstrapped } = makeDeps({
      readPrimaryEnvironmentId: () => null,
    });

    await runDesktopOpenProjectPathHandler(deps);

    expect(ensureBootstrapped).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("bails without calling dispatch if isDisposed() flips true during bootstrap", async () => {
    const disposedState = { value: false };
    const ensureBootstrapped = vi.fn(async () => {
      disposedState.value = true;
    });
    const { deps, dispatch } = makeDeps({
      isDisposed: () => disposedState.value,
      ensureBootstrapped,
    });

    await runDesktopOpenProjectPathHandler(deps);

    expect(ensureBootstrapped).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("bails without calling dispatch if the api for the primary environment is unavailable", async () => {
    const { deps, dispatch } = makeDeps({
      readApi: () => undefined,
    });

    await runDesktopOpenProjectPathHandler(deps);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("forwards dispatch onError to the toaster with a safe fallback description", async () => {
    const { deps, toast, dispatch } = makeDeps();
    dispatch.mockImplementation(async (input: OpenProjectByPathInput) => {
      input.onError?.(new Error("boom"));
      input.onError?.({ not: "an error" });
    });

    await runDesktopOpenProjectPathHandler(deps);

    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      title: "Failed to open project",
      description: "boom",
    });
    expect(toast.mock.calls[1]?.[0]).toMatchObject({
      type: "error",
      description: "An error occurred.",
    });
  });

  it("toasts and does not reject if dispatch throws synchronously", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const { deps, toast } = makeDeps({ dispatch });

    await expect(runDesktopOpenProjectPathHandler(deps)).resolves.toBeUndefined();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      description: "unexpected",
    });
  });

  it("toasts and does not reject if ensureBootstrapped throws", async () => {
    const ensureBootstrapped = vi.fn(async () => {
      throw new Error("bootstrap failed");
    });
    const readProjectSnapshot = vi.fn(() => ({ projects: [], threads: [] }));
    const { deps, toast, dispatch } = makeDeps({ ensureBootstrapped, readProjectSnapshot });

    await expect(runDesktopOpenProjectPathHandler(deps)).resolves.toBeUndefined();

    expect(readProjectSnapshot).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
