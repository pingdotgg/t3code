import { describe, expect, it } from "vitest";

import {
  canApplyLifecycleEvent,
  deriveNextStatus,
  isTerminalStatus,
  type ExecutionRunStatus,
} from "./executionLifecycle.ts";

describe("executionLifecycle", () => {
  describe("isTerminalStatus", () => {
    it.each(["completed", "failed", "interrupted"] satisfies ExecutionRunStatus[])(
      "treats %s as terminal",
      (status) => {
        expect(isTerminalStatus(status)).toBe(true);
      },
    );

    it.each(["requested", "accepted", "started", "reconciling"] satisfies ExecutionRunStatus[])(
      "treats %s as non-terminal",
      (status) => {
        expect(isTerminalStatus(status)).toBe(false);
      },
    );
  });

  describe("deriveNextStatus", () => {
    it.each([
      ["started", "started"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["interrupted", "interrupted"],
    ] as const)("maps lifecycle type %s to status %s", (type, expected) => {
      expect(deriveNextStatus(type)).toBe(expected);
    });
  });

  describe("canApplyLifecycleEvent", () => {
    it("allows started on a requested run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "requested",
        incomingType: "started",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows started on an accepted run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "accepted",
        incomingType: "started",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows completed on a started run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "started",
        incomingType: "completed",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows failed on a started run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "started",
        incomingType: "failed",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows interrupted on a started run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "started",
        incomingType: "interrupted",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows completed on a reconciling run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "reconciling",
        incomingType: "completed",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows failed on a reconciling run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "reconciling",
        incomingType: "failed",
      });
      expect(result.allowed).toBe(true);
    });

    it("rejects started on a completed run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "completed",
        incomingType: "started",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cannot re-open terminal run");
    });

    it("rejects started on a failed run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "failed",
        incomingType: "started",
      });
      expect(result.allowed).toBe(false);
    });

    it("rejects started on an interrupted run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "interrupted",
        incomingType: "started",
      });
      expect(result.allowed).toBe(false);
    });

    it("rejects failed on a completed run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "completed",
        incomingType: "failed",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Cannot transition from terminal status");
    });

    it("rejects completed on a failed run", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "failed",
        incomingType: "completed",
      });
      expect(result.allowed).toBe(false);
    });

    it("allows idempotent completed on completed", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "completed",
        incomingType: "completed",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows idempotent failed on failed", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "failed",
        incomingType: "failed",
      });
      expect(result.allowed).toBe(true);
    });

    it("allows idempotent interrupted on interrupted", () => {
      const result = canApplyLifecycleEvent({
        currentStatus: "interrupted",
        incomingType: "interrupted",
      });
      expect(result.allowed).toBe(true);
    });
  });
});
