import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextTerminalDrawerPinState, resolveTerminalDrawer } from "./terminalDrawer";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const THREAD_A1 = scopeThreadRef(ENVIRONMENT_A, ThreadId.make("thread-1"));
const THREAD_A2 = scopeThreadRef(ENVIRONMENT_A, ThreadId.make("thread-2"));
const THREAD_A3 = scopeThreadRef(ENVIRONMENT_A, ThreadId.make("thread-3"));
const THREAD_B1 = scopeThreadRef(EnvironmentId.make("environment-b"), ThreadId.make("thread-1"));

describe("resolveTerminalDrawer", () => {
  it("uses the thread's own drawer when nothing is pinned", () => {
    expect(
      resolveTerminalDrawer({
        threadRef: THREAD_A1,
        projectPinnedThreadRef: null,
        environmentPinnedThreadRef: null,
      }),
    ).toEqual({ drawerRef: THREAD_A1, pinState: "none" });
    expect(
      resolveTerminalDrawer({
        threadRef: null,
        projectPinnedThreadRef: THREAD_A1,
        environmentPinnedThreadRef: THREAD_A1,
      }),
    ).toEqual({ drawerRef: null, pinState: "none" });
  });

  it("points every thread in the project at the project pin", () => {
    expect(
      resolveTerminalDrawer({
        threadRef: THREAD_A2,
        projectPinnedThreadRef: THREAD_A1,
        environmentPinnedThreadRef: null,
      }),
    ).toEqual({ drawerRef: THREAD_A1, pinState: "project" });
    expect(
      resolveTerminalDrawer({
        threadRef: THREAD_A1,
        projectPinnedThreadRef: THREAD_A1,
        environmentPinnedThreadRef: null,
      }),
    ).toEqual({ drawerRef: THREAD_A1, pinState: "project" });
  });

  it("lets an environment pin win over a project pin", () => {
    expect(
      resolveTerminalDrawer({
        threadRef: THREAD_A2,
        projectPinnedThreadRef: THREAD_A1,
        environmentPinnedThreadRef: THREAD_A3,
      }),
    ).toEqual({ drawerRef: THREAD_A3, pinState: "environment" });
  });

  it("ignores pins from another environment", () => {
    expect(
      resolveTerminalDrawer({
        threadRef: THREAD_B1,
        projectPinnedThreadRef: THREAD_A1,
        environmentPinnedThreadRef: THREAD_A2,
      }),
    ).toEqual({ drawerRef: THREAD_B1, pinState: "none" });
  });
});

describe("nextTerminalDrawerPinState", () => {
  it("cycles off, project, environment, off", () => {
    expect(nextTerminalDrawerPinState("none")).toBe("project");
    expect(nextTerminalDrawerPinState("project")).toBe("environment");
    expect(nextTerminalDrawerPinState("environment")).toBe("none");
  });
});
