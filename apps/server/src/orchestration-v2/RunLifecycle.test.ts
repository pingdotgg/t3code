import { assert, it } from "@effect/vitest";

import { illegalLifecycleTransition, isTerminalLifecycleStatus } from "./RunLifecycle.ts";

it("treats missing rows and same-status rewrites as legal", () => {
  assert.isNull(illegalLifecycleTransition({ kind: "run", from: null, to: "completed" }));
  assert.isNull(illegalLifecycleTransition({ kind: "run", from: "cancelled", to: "cancelled" }));
  assert.isNull(
    illegalLifecycleTransition({ kind: "run-attempt", from: "superseded", to: "superseded" }),
  );
});

it("allows every transition out of a non-terminal status", () => {
  for (const from of ["preparing", "queued", "starting", "running", "waiting"]) {
    for (const to of ["running", "completed", "interrupted", "failed", "cancelled"]) {
      assert.isNull(illegalLifecycleTransition({ kind: "run", from, to }));
    }
  }
});

it("makes terminal run statuses absorbing except checkpoint rollback", () => {
  assert.isNull(illegalLifecycleTransition({ kind: "run", from: "completed", to: "rolled_back" }));
  for (const from of ["completed", "interrupted", "failed", "cancelled", "rolled_back"]) {
    for (const to of ["preparing", "queued", "starting", "running", "waiting"]) {
      assert.isNotNull(illegalLifecycleTransition({ kind: "run", from, to }));
    }
  }
  assert.isNotNull(illegalLifecycleTransition({ kind: "run", from: "cancelled", to: "completed" }));
  assert.isNotNull(
    illegalLifecycleTransition({ kind: "run", from: "interrupted", to: "rolled_back" }),
  );
});

it("never lets an attempt leave a terminal status", () => {
  for (const from of ["completed", "interrupted", "failed", "cancelled", "superseded"]) {
    for (const to of ["pending", "running", "completed", "superseded"]) {
      if (from === to) continue;
      assert.isNotNull(illegalLifecycleTransition({ kind: "run-attempt", from, to }));
    }
  }
});

it("exempts provider-owned reopenable node kinds and rollback retirement", () => {
  assert.isNull(illegalLifecycleTransition({ kind: "node", from: "completed", to: "rolled_back" }));
  assert.isNull(
    illegalLifecycleTransition({
      kind: "node",
      from: "completed",
      to: "running",
      nodeKind: "subagent",
    }),
  );
  assert.isNull(
    illegalLifecycleTransition({
      kind: "node",
      from: "interrupted",
      to: "running",
      nodeKind: "root_turn",
    }),
  );
  assert.isNotNull(
    illegalLifecycleTransition({
      kind: "node",
      from: "completed",
      to: "running",
      nodeKind: "tool_call",
    }),
  );
});

it("classifies terminal statuses per entity", () => {
  assert.isTrue(isTerminalLifecycleStatus("run", "rolled_back"));
  assert.isTrue(isTerminalLifecycleStatus("run-attempt", "superseded"));
  assert.isFalse(isTerminalLifecycleStatus("run", "waiting"));
  assert.isFalse(isTerminalLifecycleStatus("node", "pending"));
});
