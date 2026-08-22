import { describe, expect, it } from "vite-plus/test";

import { resolveFirstRunDecision } from "./firstRun.logic";

const freshWorkspace = {
  enabled: true,
  hydrated: true,
  completed: false,
  bootstrapped: true,
  authoritative: true,
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

  it("waits for live data before judging a single cached project", () => {
    expect(
      resolveFirstRunDecision({
        ...freshWorkspace,
        authoritative: false,
        workspaceFresh: false,
      }),
    ).toEqual({
      decision: "pending",
      persistCompletion: false,
    });
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
