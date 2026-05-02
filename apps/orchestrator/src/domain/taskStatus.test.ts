import { describe, expect, it } from "vitest";

import {
  isTerminalTaskStatus,
  isValidTaskStatusTransition,
  mapLinearStateToTaskStatus,
  type TaskStatus,
} from "./taskStatus.ts";

describe("task status domain helpers", () => {
  describe("isTerminalTaskStatus", () => {
    it.each(["done", "canceled"] satisfies TaskStatus[])("treats %s as terminal", (status) => {
      expect(isTerminalTaskStatus(status)).toBe(true);
    });

    it.each([
      "ready",
      "working",
      "needs_input",
      "ready_for_review",
      "blocked",
      "failed",
    ] satisfies TaskStatus[])("treats %s as non-terminal", (status) => {
      expect(isTerminalTaskStatus(status)).toBe(false);
    });
  });

  describe("isValidTaskStatusTransition", () => {
    it.each([
      ["ready", "working"],
      ["ready", "needs_input"],
      ["ready", "blocked"],
      ["working", "failed"],
      ["failed", "working"],
      ["working", "ready_for_review"],
      ["needs_input", "ready_for_review"],
      ["blocked", "ready_for_review"],
      ["ready_for_review", "done"],
      ["failed", "canceled"],
    ] satisfies [TaskStatus, TaskStatus][])("allows %s -> %s", (from, to) => {
      expect(isValidTaskStatusTransition({ from, to }).allowed).toBe(true);
    });

    it.each([
      ["ready", "done"],
      ["needs_input", "done"],
      ["blocked", "done"],
      ["failed", "ready_for_review"],
      ["done", "working"],
      ["canceled", "working"],
    ] satisfies [TaskStatus, TaskStatus][])("rejects %s -> %s", (from, to) => {
      const result = isValidTaskStatusTransition({ from, to });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("allows idempotent transitions", () => {
      expect(isValidTaskStatusTransition({ from: "done", to: "done" }).allowed).toBe(true);
      expect(isValidTaskStatusTransition({ from: "working", to: "working" }).allowed).toBe(true);
    });

    it("allows cancellation from active statuses", () => {
      const cancelableStatuses = [
        "ready",
        "working",
        "needs_input",
        "blocked",
        "failed",
        "ready_for_review",
      ] satisfies TaskStatus[];

      for (const from of cancelableStatuses) {
        expect(isValidTaskStatusTransition({ from, to: "canceled" }).allowed).toBe(true);
      }
    });
  });

  describe("mapLinearStateToTaskStatus", () => {
    it.each([
      ["backlog", "ready"],
      ["unstarted", "ready"],
      ["started", "working"],
      ["completed", "done"],
      ["canceled", "canceled"],
    ] as const)("maps Linear workflow type %s to %s", (type, expected) => {
      expect(mapLinearStateToTaskStatus({ type })).toBe(expected);
    });

    it.each([
      ["Backlog", "ready"],
      ["In Progress", "working"],
      ["Needs Input", "needs_input"],
      ["Blocked", "blocked"],
      ["Ready for Review", "ready_for_review"],
      ["Done", "done"],
      ["Cancelled", "canceled"],
    ] as const)("maps Linear state name %s to %s", (name, expected) => {
      expect(mapLinearStateToTaskStatus({ name })).toBe(expected);
    });

    it("prefers Linear workflow type over a custom state name", () => {
      expect(mapLinearStateToTaskStatus({ type: "started", name: "Ready for Review" })).toBe(
        "working",
      );
    });

    it("returns undefined for unknown Linear states", () => {
      expect(mapLinearStateToTaskStatus({ name: "Customer Escalation" })).toBeUndefined();
      expect(mapLinearStateToTaskStatus({})).toBeUndefined();
    });
  });
});
