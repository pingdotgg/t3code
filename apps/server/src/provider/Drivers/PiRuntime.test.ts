import { describe, expect, it } from "vite-plus/test";

import {
  buildPiLaunchPlan,
  buildPiModelProbeLaunchPlan,
  parsePiVersion,
  PI_MINIMUM_VERSION,
  validatePiLaunchArgs,
} from "./PiRuntime.ts";

describe("Pi runtime launch plan", () => {
  it("keeps the Pi configuration directory in PI_AGENT_DIR", () => {
    const plan = buildPiLaunchPlan({
      configDirectory: "/Users/example/.pi-work",
      launchArgs: "--verbose",
      sessionDirectory: "/tmp/t3/pi/work",
      sessionId: "thread_123",
    });

    expect(plan).toEqual({
      _tag: "Success",
      args: [
        "--verbose",
        "--mode",
        "rpc",
        "--session-dir",
        "/tmp/t3/pi/work",
        "--session-id",
        "thread_123",
      ],
      environment: { PI_AGENT_DIR: "/Users/example/.pi-work" },
    });
  });

  it("leaves Pi's normal configuration untouched when no config directory is selected", () => {
    const plan = buildPiLaunchPlan({
      configDirectory: "",
      launchArgs: "",
      sessionDirectory: "/tmp/t3/pi/work",
      sessionId: "thread_123",
    });

    expect(plan).toEqual({
      _tag: "Success",
      args: ["--mode", "rpc", "--session-dir", "/tmp/t3/pi/work", "--session-id", "thread_123"],
      environment: {},
    });
  });

  it.each([
    "--mode json",
    "--session-dir /tmp/other",
    "--session other",
    "--session=other",
    "--session-id=other",
    "--no-session",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--fork prior-session",
  ])("rejects user launch arguments that override managed Pi parameters: %s", (launchArgs) => {
    expect(
      buildPiLaunchPlan({
        configDirectory: "",
        launchArgs,
        sessionDirectory: "/tmp/t3/pi/work",
        sessionId: "thread_123",
      }),
    ).toEqual({ _tag: "Failure", message: expect.stringContaining("managed by T3 Code") });
  });
});

describe("Pi model probe launch plan", () => {
  it("uses Pi RPC without creating a probe session", () => {
    expect(
      buildPiModelProbeLaunchPlan({
        configDirectory: "/Users/example/.pi-work",
        launchArgs: "--verbose",
      }),
    ).toEqual({
      _tag: "Success",
      args: ["--verbose", "--mode", "rpc", "--no-session"],
      environment: { PI_AGENT_DIR: "/Users/example/.pi-work" },
    });
  });
});

describe("validatePiLaunchArgs", () => {
  it("rejects T3 Code managed flags before launching Pi", () => {
    expect(validatePiLaunchArgs("--mode json")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--session-dir=/tmp/other")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--session-id=other")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--no-session")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--verbose")).toBeUndefined();
  });
});

describe("parsePiVersion", () => {
  it("accepts Pi 0.81.1 and newer", () => {
    expect(parsePiVersion("pi 0.81.1")).toEqual({ _tag: "Supported", version: PI_MINIMUM_VERSION });
    expect(parsePiVersion("pi 0.82.0")).toEqual({ _tag: "Supported", version: "0.82.0" });
  });

  it("reports an upgrade requirement for older Pi versions", () => {
    expect(parsePiVersion("pi 0.81.0")).toEqual({ _tag: "Unsupported", version: "0.81.0" });
    expect(parsePiVersion("pi 0.80.99")).toEqual({ _tag: "Unsupported", version: "0.80.99" });
  });

  it("reports invalid version output", () => {
    expect(parsePiVersion("not a version")).toEqual({ _tag: "Invalid" });
  });
});
