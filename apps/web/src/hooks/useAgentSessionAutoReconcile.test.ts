import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";

import {
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

  it("classifies an RpcClientError as unsupported-server", () => {
    const rpcError = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "unknown method",
        cause: new Error("socket closed"),
      }),
    });
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(rpcError)))).toBe(
      "unsupported-server",
    );
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

  it("classifies EnvironmentRpcUnavailableError as expected", () => {
    const error = { _tag: "EnvironmentRpcUnavailableError" as const, environmentId: "env-1" };
    expect(classifyImportFailure(AsyncResult.failure(Cause.fail(error)))).toBe("expected");
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
