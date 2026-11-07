import { expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { reconcileMarkJump, type MarkJump } from "./markJump";

const environmentId = EnvironmentId.make("env-1");

function jump(overrides: Partial<MarkJump> = {}): MarkJump {
  return {
    path: "App.swift",
    line: 42,
    requestId: 1,
    baselineRouteLine: 10,
    cwd: "/repo",
    environmentId,
    ...overrides,
  };
}

it("clears a mark jump across route-line changes so 10 → 20 → 10 cannot revive it", () => {
  let markJump: MarkJump | null = jump({ baselineRouteLine: 10, line: 42 });
  const workspace = { path: "App.swift", cwd: "/repo", environmentId };

  markJump = reconcileMarkJump(markJump, { ...workspace, routeLine: 20 });
  expect(markJump).toBeNull();

  markJump = reconcileMarkJump(markJump, { ...workspace, routeLine: 10 });
  expect(markJump).toBeNull();
});

it("keeps a mark jump while the route line and workspace stay the same", () => {
  const markJump = jump();
  expect(
    reconcileMarkJump(markJump, {
      path: "App.swift",
      routeLine: 10,
      cwd: "/repo",
      environmentId,
    }),
  ).toBe(markJump);
});

it("clears a mark jump when the workspace changes at the same path and route line", () => {
  expect(
    reconcileMarkJump(jump(), {
      path: "App.swift",
      routeLine: 10,
      cwd: "/other",
      environmentId,
    }),
  ).toBeNull();
});
