import type {
  EnvironmentId,
  PipelineDefinition,
  ProjectId,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoBalanceCandidates,
  eligiblePipelineMachines,
  pipelineCommentDescription,
  pipelineProvidersReady,
  resolveAutoMachineState,
  resolveLinearWriteBackRoute,
  resolvePipelineMachineChoice,
  resolvePipelineSelection,
  type PipelineMachine,
  type PipelineMachineInput,
} from "./pipelineMachines.ts";

const env = (id: string) => id as EnvironmentId;
const project = (id: string) => id as ProjectId;

const input = (
  id: string,
  overrides: Partial<PipelineMachineInput> = {},
): PipelineMachineInput => ({
  environmentId: env(id),
  label: id,
  isPrimary: id === "a",
  connected: true,
  supportsPipelines: true,
  canStart: true,
  projectId: project(`p-${id}`),
  ...overrides,
});

describe("eligiblePipelineMachines", () => {
  it("keeps connected, pipeline-capable, permitted machines with the project, primary first", () => {
    const machines = eligiblePipelineMachines([
      input("c"),
      input("b", { connected: false }),
      input("d", { supportsPipelines: false }),
      input("e", { canStart: false }),
      input("f", { projectId: null }),
      input("a"),
    ]);
    expect(machines.map((machine) => machine.environmentId)).toEqual(["a", "c"]);
    expect(machines[1]?.projectId).toBe("p-c");
  });
});

describe("resolvePipelineMachineChoice", () => {
  const machines: ReadonlyArray<PipelineMachine> = eligiblePipelineMachines([
    input("a"),
    input("b"),
  ]);

  it("defaults to Auto only when balancing is on and there is a choice", () => {
    expect(resolvePipelineMachineChoice({ choice: null, machines, autoOffered: true })).toBe(
      "auto",
    );
    expect(resolvePipelineMachineChoice({ choice: null, machines, autoOffered: false })).toBe("a");
    expect(
      resolvePipelineMachineChoice({
        choice: null,
        machines: machines.slice(0, 1),
        autoOffered: true,
      }),
    ).toBe("a");
  });

  it("can offer Auto without defaulting to it", () => {
    const input = { choice: null, machines, autoOffered: true, autoByDefault: false } as const;
    expect(resolvePipelineMachineChoice(input)).toBe("a");
    expect(resolvePipelineMachineChoice({ ...input, choice: "auto" })).toBe("auto");
  });

  it("keeps a manual pick while eligible and drops it when the machine goes away", () => {
    expect(resolvePipelineMachineChoice({ choice: env("b"), machines, autoOffered: true })).toBe(
      "b",
    );
    expect(
      resolvePipelineMachineChoice({
        choice: env("b"),
        machines: machines.slice(0, 1),
        autoOffered: false,
      }),
    ).toBe("a");
    expect(resolvePipelineMachineChoice({ choice: "auto", machines, autoOffered: false })).toBe(
      "a",
    );
  });
});

describe("autoBalanceCandidates", () => {
  const machines = eligiblePipelineMachines([input("a"), input("b"), input("c")]);

  it("drops manual-only machines and machines whose providers are not ready", () => {
    expect(
      autoBalanceCandidates({
        machines,
        weights: { b: 0 },
        defaultWeight: 50,
        providersReady: (machine) => machine.environmentId !== "c",
      }),
    ).toEqual(["a"]);
  });

  it("treats every machine as Normal without weights", () => {
    expect(
      autoBalanceCandidates({
        machines,
        weights: {},
        defaultWeight: 50,
        providersReady: () => true,
      }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("resolveAutoMachineState", () => {
  it("checks, picks, latches and reports unavailable", () => {
    const base = { latched: null, pending: false, picked: null, candidateCount: 2 };
    expect(resolveAutoMachineState({ ...base, pending: true })).toEqual({ kind: "checking" });
    expect(resolveAutoMachineState({ ...base, picked: env("b") })).toEqual({
      kind: "picked",
      environmentId: "b",
    });
    expect(resolveAutoMachineState(base)).toEqual({ kind: "unavailable" });
    expect(resolveAutoMachineState({ ...base, candidateCount: 0, pending: true })).toEqual({
      kind: "unavailable",
    });
    expect(resolveAutoMachineState({ ...base, latched: env("a"), picked: env("b") })).toEqual({
      kind: "picked",
      environmentId: "a",
    });
  });
});

describe("pipelineProvidersReady", () => {
  const pipeline = {
    steps: [
      { modelSelection: { instanceId: "codex" } },
      { modelSelection: { instanceId: "claude" } },
    ],
  } as unknown as PipelineDefinition;
  const provider = (instanceId: string, overrides: object = {}) =>
    ({
      instanceId,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      availability: "available",
      ...overrides,
    }) as unknown as ServerProvider;

  it("needs every step's provider ready", () => {
    const ready = [provider("codex"), provider("claude")];
    expect(
      pipelineProvidersReady({
        pipeline,
        providers: ready,
        settings: null,
        projectId: project("p"),
      }),
    ).toBe(true);
    expect(
      pipelineProvidersReady({
        pipeline,
        providers: [provider("codex"), provider("claude", { auth: { status: "unauthenticated" } })],
        settings: null,
        projectId: project("p"),
      }),
    ).toBe(false);
    expect(
      pipelineProvidersReady({
        pipeline,
        providers: [provider("codex")],
        settings: null,
        projectId: project("p"),
      }),
    ).toBe(false);
  });
});

describe("resolvePipelineSelection", () => {
  const pipelines = [
    { id: "x1", name: "Review" },
    { id: "x2", name: "Ship" },
    { id: "x3", name: "Ship" },
  ];
  const none = { chosenName: null, requestedName: null, lastUsedName: null };

  it("keeps the chosen pipeline by name, first match on collisions", () => {
    expect(resolvePipelineSelection({ pipelines, ...none, chosenName: "Ship" }).pipeline?.id).toBe(
      "x2",
    );
  });

  it("falls back to requested, last used, then the first, and flags a lost choice", () => {
    expect(
      resolvePipelineSelection({ pipelines, ...none, requestedName: "Ship" }).pipeline?.id,
    ).toBe("x2");
    expect(
      resolvePipelineSelection({ pipelines, ...none, lastUsedName: "Ship" }).pipeline?.id,
    ).toBe("x2");
    expect(resolvePipelineSelection({ pipelines, ...none }).pipeline?.id).toBe("x1");
    const lost = resolvePipelineSelection({
      pipelines,
      ...none,
      chosenName: "Gone",
      lastUsedName: "Ship",
    });
    expect(lost.pipeline?.id).toBe("x2");
    expect(lost.unmatchedName).toBe("Gone");
    expect(resolvePipelineSelection({ pipelines: [], ...none, chosenName: "Gone" })).toEqual({
      pipeline: null,
      unmatchedName: null,
    });
  });
});

describe("resolveLinearWriteBackRoute", () => {
  const route = (
    runLinear: { state: string; organizationId: string | null } | null,
    runEnvironmentId = "b",
  ) =>
    resolveLinearWriteBackRoute({
      runEnvironmentId: env(runEnvironmentId),
      runMachineName: "Studio",
      primaryEnvironmentId: env("a"),
      primaryOrganizationId: "org-1",
      runLinear,
    });

  it("leaves a run on the primary alone", () => {
    expect(route(null, "a")).toEqual({ kind: "primary", recordOn: "a" });
  });

  it("lets the run's machine record when it is connected to the same organization", () => {
    expect(route({ state: "connected", organizationId: "org-1" })).toEqual({
      kind: "seamless",
      recordOn: "b",
    });
  });

  it("falls back to the primary for another organization, a bad connection or no answer", () => {
    const fallback = { kind: "fallback", recordOn: "a", machineName: "Studio" };
    expect(route({ state: "connected", organizationId: "org-2" })).toEqual(fallback);
    expect(route({ state: "invalid", organizationId: "org-1" })).toEqual(fallback);
    expect(route({ state: "connected", organizationId: null })).toEqual(fallback);
    expect(route(null)).toEqual(fallback);
  });

  it("says in the comment row when the comment will not be updated", () => {
    expect(
      pipelineCommentDescription(route({ state: "connected", organizationId: "org-1" })),
    ).toContain("updated as each step");
    expect(pipelineCommentDescription(route(null))).toBe(
      "One comment with a link (not updated: Studio has no matching Linear connection)",
    );
  });
});
