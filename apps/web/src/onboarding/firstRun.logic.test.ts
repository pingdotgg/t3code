import { describe, expect, it } from "vite-plus/test";

import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  transitionFirstRunGateState,
} from "./firstRun.logic";

const freshWorkspace = {
  enabled: true,
  hydrated: true,
  completed: false,
  bootstrapped: true,
  authoritative: true,
  workspaceAuthoritative: true,
  workspaceProvenanceAuthoritative: true,
  catalogReady: true,
  serverConfigAvailable: true,
  workspaceFresh: true,
  projectCount: 1,
  threadCount: 1,
} as const;

describe("resolveFirstRunDecision", () => {
  it("opens the wizard for an authoritative fresh workspace", () => {
    expect(resolveFirstRunDecision(freshWorkspace)).toEqual({
      decision: "wizard",
      persistCompletion: false,
    });
  });

  it("does not permanently complete onboarding from cached project counts", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("backfills completion once existing projects are confirmed by the server", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        projectCount: 3,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });

  it("waits when the initial welcome is pending and opens the wizard after completion", () => {
    const pendingProvenance = isFirstRunWorkspaceProvenanceAuthoritative({
      welcomeReceived: true,
      bootstrapStatus: "pending",
    });
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceProvenanceAuthoritative: pendingProvenance,
      }),
    ).toEqual({ decision: "pending", persistCompletion: false });

    const completedProvenance = isFirstRunWorkspaceProvenanceAuthoritative({
      welcomeReceived: true,
      bootstrapStatus: "complete",
    });
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        workspaceProvenanceAuthoritative: completedProvenance,
      }),
    ).toEqual({ decision: "wizard", persistCompletion: false });
  });

  it("does not wait for server data after onboarding is already complete", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        bootstrapped: false,
        completed: true,
        serverConfigAvailable: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });
});

describe("isFirstRunWorkspaceProvenanceAuthoritative", () => {
  it("accepts a legacy welcome without bootstrap status", () => {
    expect(
      isFirstRunWorkspaceProvenanceAuthoritative({
        welcomeReceived: true,
        bootstrapStatus: null,
      }),
    ).toBe(true);
  });
});

describe("transitionFirstRunGateState", () => {
  it("shows recovery without mounting the app when evidence stalls", () => {
    expect(
      transitionFirstRunGateState({ decision: "pending", stalled: false }, { type: "timeout" }),
    ).toEqual({ decision: "pending", stalled: true });
  });

  it.each([
    { previous: "app", workspaceFresh: true, decision: "wizard" },
    { previous: "wizard", workspaceFresh: false, decision: "app" },
  ] as const)(
    "updates $previous to $decision when authoritative workspace evidence changes",
    ({ previous, workspaceFresh, decision }) => {
      const evidence = resolveFirstRunDecision({ ...freshWorkspace, workspaceFresh });
      expect(
        transitionFirstRunGateState(
          { decision: previous, stalled: false },
          { type: "evidence", decision: evidence.decision },
        ),
      ).toEqual({ decision, stalled: false });
    },
  );

  // regression: #19680 unchanged gate evidence must not produce a new state
  it.each(["pending", "app", "wizard"] as const)(
    "preserves state identity for unchanged %s evidence",
    (decision) => {
      const state = { decision, stalled: false };
      expect(transitionFirstRunGateState(state, { type: "evidence", decision })).toBe(state);
    },
  );
});

const primaryEnvironmentId = "primary-environment";
const bootstrapProject = {
  id: "bootstrap-project",
  environmentId: primaryEnvironmentId,
  workspaceRoot: "/projects/current",
};
const bootstrapThread = {
  id: "bootstrap-thread",
  projectId: bootstrapProject.id,
  environmentId: primaryEnvironmentId,
  latestRun: null,
  latestUserMessageAt: null,
  runtime: null,
};

const freshBootstrap = {
  primaryEnvironmentId,
  serverCwd: "/projects/current",
  bootstrapProjectId: bootstrapProject.id,
  bootstrapThreadId: bootstrapThread.id,
  bootstrapProjectCreated: true,
  bootstrapThreadCreated: true,
  projects: [bootstrapProject],
  threads: [bootstrapThread],
};

describe("isFreshFirstRunWorkspace", () => {
  it("accepts only the unused project and thread created from the server cwd", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current/",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(true);
  });

  it("rejects an existing unused cwd project and thread reused by startup", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: false,
        bootstrapThreadCreated: false,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(false);
  });

  it("rejects a nonempty workspace when an older server omits creation provenance", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "/projects/current",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        projects: [bootstrapProject],
        threads: [bootstrapThread],
      }),
    ).toBe(false);
  });

  it("normalizes Windows project paths before checking the bootstrap workspace", () => {
    expect(
      isFreshFirstRunWorkspace({
        primaryEnvironmentId,
        serverCwd: "C:\\Projects\\Current\\",
        bootstrapProjectId: bootstrapProject.id,
        bootstrapThreadId: bootstrapThread.id,
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
        projects: [{ ...bootstrapProject, workspaceRoot: "c:/projects/current" }],
        threads: [bootstrapThread],
      }),
    ).toBe(true);
  });

  it("rejects a bootstrap thread that already has a user message", () => {
    expect(
      isFreshFirstRunWorkspace({
        ...freshBootstrap,
        projects: [bootstrapProject],
        threads: [
          {
            ...bootstrapThread,
            latestUserMessageAt: "2026-08-23T12:00:00.000Z",
          },
        ],
      }),
    ).toBe(false);
  });
});
