import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import { SocketCloseError } from "effect/unstable/socket/Socket";

import {
  useAgentSessionAutoReconcile,
  classifyImportFailure,
  isDefinitiveOutcome,
  projectReconcileKey,
  selectUnreconciledProjects,
} from "./useAgentSessionAutoReconcile";

function makeProject(
  environmentId: string,
  projectId: string,
  workspaceRoot = `/home/user/${projectId}`,
): EnvironmentProject {
  return {
    environmentId: environmentId as EnvironmentId,
    id: projectId as ProjectId,
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as EnvironmentProject;
}

describe("selectUnreconciledProjects", () => {
  it("returns all projects when none have been reconciled", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-1", "proj-b")];
    const result = selectUnreconciledProjects(projects, reconciled);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("proj-a");
    expect(result[1]!.id).toBe("proj-b");
  });

  it("does not mutate the reconciled set", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a")];
    selectUnreconciledProjects(projects, reconciled);
    expect(reconciled.size).toBe(0);
  });

  it("skips projects already in the reconciled set", () => {
    const project = makeProject("env-1", "proj-a");
    const reconciled = new Set([projectReconcileKey(project)]);
    const result = selectUnreconciledProjects([project], reconciled);
    expect(result).toHaveLength(0);
  });

  it("returns only projects not yet reconciled", () => {
    const projA = makeProject("env-1", "proj-a");
    const projB = makeProject("env-1", "proj-b");
    const reconciled = new Set([projectReconcileKey(projA)]);
    const result = selectUnreconciledProjects([projA, projB], reconciled);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("proj-b");
  });

  it("returns empty array when projects list is empty", () => {
    const result = selectUnreconciledProjects([], new Set());
    expect(result).toHaveLength(0);
  });

  it("distinguishes projects with the same id across different environments", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a"), makeProject("env-2", "proj-a")];
    const result = selectUnreconciledProjects(projects, reconciled);
    expect(result).toHaveLength(2);
  });

  it("allows retry when a project is not marked reconciled after failure", () => {
    const reconciled = new Set<string>();
    const projects = [makeProject("env-1", "proj-a")];

    const first = selectUnreconciledProjects(projects, reconciled);
    expect(first).toHaveLength(1);

    const second = selectUnreconciledProjects(projects, reconciled);
    expect(second).toHaveLength(1);

    reconciled.add(projectReconcileKey(projects[0]!));
    const third = selectUnreconciledProjects(projects, reconciled);
    expect(third).toHaveLength(0);
  });
});

describe("classifyImportFailure", () => {
  it("classifies an interrupted result as interrupted", () => {
    const result = AsyncResult.failure(Cause.interrupt());
    expect(classifyImportFailure(result)).toBe("interrupted");
  });

  it("classifies a transport RpcClientDefect as unexpected", () => {
    const rpcError = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "unknown method",
        cause: new Error("socket closed"),
      }),
    });
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(rpcError)))).toBe("unexpected");
  });

  it.each([
    "Unknown request tag: agentSessions.import",
    new Error("Unknown request tag: agentSessions.import"),
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "Remote defect",
        cause: "Unknown request tag: agentSessions.import",
      }),
    }),
  ])("recognizes the server's missing import method defect: %s", (error) => {
    expect(classifyImportFailure(AsyncResult.failure(Cause.die(error)))).toBe("unsupported-server");
  });

  it("does not mistake a different unknown request tag for a missing import method", () => {
    expect(classifyImportFailure(AsyncResult.failure(Cause.die("Unknown request tag: Ack")))).toBe(
      "unexpected",
    );
  });

  it("keeps socket closure errors retryable", () => {
    const error = new RpcClientError.RpcClientError({
      reason: new SocketCloseError({ code: 1006, closeReason: "Disconnected" }),
    });
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("unexpected");
  });

  it("keeps protocol decoding defects retryable", () => {
    const error = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "Error decoding HTTP response",
        cause: new Error("Invalid JSON"),
      }),
    });
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("unexpected");
  });

  it("classifies AgentSessionImportProjectNotFoundError as expected", () => {
    const error = { _tag: "AgentSessionImportProjectNotFoundError" as const, projectId: "proj-1" };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("expected");
  });

  it("classifies AgentSessionImportProjectChangedError as expected", () => {
    const error = { _tag: "AgentSessionImportProjectChangedError" as const, projectId: "proj-1" };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("expected");
  });

  it("classifies AgentSessionScanError as expected", () => {
    const error = { _tag: "AgentSessionScanError" as const, operation: "read-settings" };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("expected");
  });

  it("keeps a temporarily unavailable environment retryable", () => {
    const error = new EnvironmentRpcUnavailableError({
      environmentId: "env-1",
      message: "Disconnected",
    });
    const kind = classifyImportFailure(AsyncResult.failure(Cause.fail(error)));
    expect(kind).toBe("unexpected");
    expect(isDefinitiveOutcome(kind)).toBe(false);
  });

  it("classifies EnvironmentAuthorizationError as expected", () => {
    const error = { _tag: "EnvironmentAuthorizationError" as const };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("expected");
  });

  it("classifies a die (defect) as unexpected", () => {
    expect(classifyImportFailure(AsyncResult.failure(Cause.die(new Error("boom"))))).toBe(
      "unexpected",
    );
  });

  it("classifies an unknown tagged error as unexpected", () => {
    const error = { _tag: "SomethingWeird" as const };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("unexpected");
  });

  it("classifies a plain Error as unexpected", () => {
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(new Error("plain"))))).toBe(
      "unexpected",
    );
  });
});

describe("isDefinitiveOutcome", () => {
  it("treats expected failures as definitive (no retry)", () => {
    expect(isDefinitiveOutcome("expected")).toBe(true);
  });

  it("treats unsupported-server as non-definitive (retry after upgrade)", () => {
    expect(isDefinitiveOutcome("unsupported-server")).toBe(false);
  });

  it("treats unexpected failures as non-definitive (retry)", () => {
    expect(isDefinitiveOutcome("unexpected")).toBe(false);
  });

  it("treats interrupted as non-definitive (retry)", () => {
    expect(isDefinitiveOutcome("interrupted")).toBe(false);
  });
});

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  bootstrapped: true,
  importSessions: vi.fn(),
}));
vi.mock("../state/entities", () => ({
  useProjects: () => state.projects,
  useAllEnvironmentShellsBootstrapped: () => state.bootstrapped,
}));
vi.mock("../state/agentSessions", () => ({ agentSessionImport: {} }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.importSessions }));

function Reconciler() {
  useAgentSessionAutoReconcile();
  return null;
}

describe("useAgentSessionAutoReconcile retry lifecycle", () => {
  let renderer: ReactTestRenderer | undefined;
  const success = AsyncResult.success({ importedCount: 1, skippedCount: 0 });
  const unexpected = AsyncResult.failure(Cause.die(new Error("socket closed")));
  const unsupported = AsyncResult.failure(Cause.die("Unknown request tag: agentSessions.import"));

  async function render() {
    await act(() => {
      if (renderer) renderer.update(createElement(Reconciler));
      else renderer = create(createElement(Reconciler));
    });
  }
  async function advance(ms: number) {
    await act(() => vi.advanceTimersByTimeAsync(ms));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.projects = [makeProject("env-1", "proj-a")];
    state.bootstrapped = true;
    state.importSessions.mockReset().mockResolvedValue(unexpected);
  });
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("delays retries across project updates and stops after three attempts", async () => {
    await render();
    for (let i = 0; i < 4; i++) {
      state.projects = [...state.projects];
      await render();
    }
    await advance(4_999);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(state.importSessions).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(state.importSessions).toHaveBeenCalledTimes(3);
    state.projects = [...state.projects];
    await render();
    await advance(60_000);
    expect(state.importSessions).toHaveBeenCalledTimes(3);
  });

  it("marks success reconciled and cancels further retries", async () => {
    state.importSessions.mockResolvedValueOnce(unexpected).mockResolvedValue(success);
    await render();
    await advance(5_000);
    state.projects = [...state.projects];
    await render();
    await advance(60_000);
    expect(state.importSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps retry budgets separate across projects and environments", async () => {
    state.projects.push(makeProject("env-1", "proj-b"), makeProject("env-2", "proj-a"));
    await render();
    await advance(5_000);
    await advance(5_000);
    await advance(60_000);
    expect(state.importSessions).toHaveBeenCalledTimes(9);
    for (const project of state.projects) {
      expect(
        state.importSessions.mock.calls.filter(
          ([request]) =>
            request.environmentId === project.environmentId &&
            request.input.projectId === project.id,
        ),
      ).toHaveLength(3);
    }
  });

  it("retries a temporary disconnect after bootstrap returns", async () => {
    state.importSessions
      .mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentRpcUnavailableError({ environmentId: "env-1", message: "Disconnected" }),
          ),
        ),
      )
      .mockResolvedValue(success);
    await render();
    state.bootstrapped = false;
    await render();
    await advance(5_000);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
    state.bootstrapped = true;
    await render();
    expect(state.importSessions).toHaveBeenCalledTimes(2);
  });

  it("clears unsupported environments on bootstrap loss", async () => {
    state.projects.push(makeProject("env-1", "proj-b"));
    state.importSessions.mockResolvedValueOnce(unsupported).mockResolvedValue(success);
    await render();
    state.projects = [...state.projects];
    await render();
    expect(state.importSessions).toHaveBeenCalledTimes(1);
    state.bootstrapped = false;
    await render();
    state.bootstrapped = true;
    await render();
    expect(state.importSessions).toHaveBeenCalledTimes(3);
  });

  it("does not overlap requests when projects change during an import", async () => {
    let finish!: (result: typeof unexpected) => void;
    state.importSessions.mockReturnValueOnce(
      new Promise<typeof unexpected>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    state.projects = [...state.projects];
    await render();
    await advance(10_000);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
    await act(() => finish(unexpected));
    await advance(4_999);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(state.importSessions).toHaveBeenCalledTimes(2);
  });

  it("records success even if projects changed during the request", async () => {
    let finish!: (result: typeof success) => void;
    state.importSessions.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    state.projects = [...state.projects];
    await render();
    await act(() => finish(success));
    await advance(60_000);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
  });

  it("clears pending retry timers on unmount", async () => {
    await render();
    await act(() => renderer?.unmount());
    await advance(60_000);
    expect(state.importSessions).toHaveBeenCalledTimes(1);
  });
});
