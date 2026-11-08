import {
  EnvironmentId,
  ManagedCloudSandboxResourceId,
  SandboxProfileId,
  type CloudSandboxProfileStatus,
  type ManagedCloudSandboxResource,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  cloudSandboxControlOperation,
  cloudSandboxFailureMessage,
  countRunningCloudSandboxes,
  describeCloudSandbox,
  describeCloudSandboxProfile,
  offersCloudSandboxControl,
  parseSandboxProfileLimits,
} from "./cloudSandbox.ts";

const profileStatus = (overrides: {
  readonly defaultSize?: CloudSandboxProfileStatus["profile"]["defaultSize"];
  readonly autoStopMinutes?: number;
  readonly monthlyBudgetUsd?: number | null;
  readonly spendUsd?: number | null;
  readonly maxConcurrentSandboxes?: number;
}): CloudSandboxProfileStatus => ({
  profile: {
    profileId: SandboxProfileId.make("boat-main"),
    name: "boat.dev",
    driverKind: "boat",
    apiKeySet: true,
    defaultSize: "defaultSize" in overrides ? overrides.defaultSize : "default",
    autoStopMinutes: overrides.autoStopMinutes ?? 60,
    template: null,
    monthlyBudgetUsd: overrides.monthlyBudgetUsd ?? null,
    maxConcurrentSandboxes: overrides.maxConcurrentSandboxes ?? 3,
  },
  spend:
    overrides.spendUsd === null || overrides.spendUsd === undefined
      ? null
      : { period: "2026-11", usd: overrides.spendUsd, running: 0 },
});

const resource = (overrides: {
  readonly id: string;
  readonly phase: ManagedCloudSandboxResource["phase"];
  readonly profileId?: string;
  readonly sandboxId?: string | null;
}): ManagedCloudSandboxResource => ({
  resourceId: ManagedCloudSandboxResourceId.make(overrides.id),
  controllerEnvironmentId: EnvironmentId.make("controller"),
  driverKind: "boat",
  profileId: SandboxProfileId.make(overrides.profileId ?? "boat-main"),
  sandboxId: overrides.sandboxId === undefined ? "sbx-1" : overrides.sandboxId,
  parentResourceId: null,
  phase: overrides.phase,
  environmentId: null,
  label: overrides.id,
  recordingIds: [],
});

describe("describeCloudSandboxProfile", () => {
  it("summarises size, auto-stop, budget, and concurrency", () => {
    expect(
      describeCloudSandboxProfile(
        profileStatus({ monthlyBudgetUsd: 50, spendUsd: 12.5, autoStopMinutes: 120 }),
        1,
      ),
    ).toBe(
      "Standard · Auto-stop 2 h · $12.50 from deleted sandboxes of $50.00 this month · 1 running of 3 allowed",
    );
  });

  it("names the missing default size, uses minutes for partial hours, and reads no budget as no limit", () => {
    expect(
      describeCloudSandboxProfile(profileStatus({ defaultSize: null, autoStopMinutes: 90 }), 0),
    ).toBe("No default size · Auto-stop 90 min · No budget limit · 0 running of 3 allowed");
  });

  it("reads zero spend when the period has no spend record", () => {
    expect(describeCloudSandboxProfile(profileStatus({ monthlyBudgetUsd: 20 }), 0)).toContain(
      "$0.00 from deleted sandboxes of $20.00 this month",
    );
  });

  it("shows spend between zero and a cent as under one cent", () => {
    expect(
      describeCloudSandboxProfile(profileStatus({ monthlyBudgetUsd: 20, spendUsd: 0.00118 }), 0),
    ).toContain("<$0.01 from deleted sandboxes of $20.00 this month");
  });
});

describe("describeCloudSandbox", () => {
  it("joins the phase label and sandbox id, and omits a missing id", () => {
    expect(describeCloudSandbox(resource({ id: "a", phase: "connected" }))).toBe("Running · sbx-1");
    expect(describeCloudSandbox(resource({ id: "a", phase: "stopped", sandboxId: null }))).toBe(
      "Stopped",
    );
  });
});

describe("countRunningCloudSandboxes", () => {
  it("counts a profile's sandboxes that are neither stopped nor failed", () => {
    const resources = [
      resource({ id: "running", phase: "connected" }),
      resource({ id: "stopped", phase: "stopped" }),
      resource({ id: "failed", phase: "failed" }),
      resource({ id: "other", phase: "connected", profileId: "other-profile" }),
    ];
    expect(countRunningCloudSandboxes(resources, SandboxProfileId.make("boat-main"))).toBe(1);
  });
});

describe("cloudSandboxControlOperation", () => {
  it("resumes a stopped sandbox and stops any other", () => {
    expect(cloudSandboxControlOperation(resource({ id: "a", phase: "stopped" }))).toEqual({
      _tag: "resume",
    });
    expect(cloudSandboxControlOperation(resource({ id: "a", phase: "connected" }))).toEqual({
      _tag: "stop",
    });
  });

  it("offers stop and resume only in the phases where they apply", () => {
    expect(offersCloudSandboxControl("connected")).toBe(true);
    expect(offersCloudSandboxControl("stopped")).toBe(true);
    expect(offersCloudSandboxControl("deleting")).toBe(false);
    expect(offersCloudSandboxControl("failed")).toBe(false);
  });
});

describe("parseSandboxProfileLimits", () => {
  const valid = { monthlyBudgetUsd: "", maxConcurrentSandboxes: 3, template: "" };

  it("reads a blank budget and template as no limit and no snapshot", () => {
    expect(parseSandboxProfileLimits(valid)).toEqual(
      Result.succeed({ monthlyBudgetUsd: null, maxConcurrentSandboxes: 3, template: null }),
    );
  });

  it("parses a decimal budget and trims the template", () => {
    expect(
      parseSandboxProfileLimits({ ...valid, monthlyBudgetUsd: " 12.5 ", template: " snap-1 " }),
    ).toEqual(
      Result.succeed({ monthlyBudgetUsd: 12.5, maxConcurrentSandboxes: 3, template: "snap-1" }),
    );
  });

  it.each(["0", "-4", "abc", "1e3", "12,5"])("rejects the budget %s", (monthlyBudgetUsd) => {
    expect(parseSandboxProfileLimits({ ...valid, monthlyBudgetUsd })).toEqual(
      Result.fail("Monthly budget must be a dollar amount above 0, or blank for no limit."),
    );
  });

  it.each([0, 101, 2.5, Number.NaN])(
    "rejects %s concurrent sandboxes",
    (maxConcurrentSandboxes) => {
      expect(parseSandboxProfileLimits({ ...valid, maxConcurrentSandboxes })).toEqual(
        Result.fail("Concurrent sandboxes must be a whole number from 1 to 100."),
      );
    },
  );
});

describe("cloudSandboxFailureMessage", () => {
  it("returns the server detail, then the error message, and null without a failure", () => {
    expect(cloudSandboxFailureMessage(AsyncResult.success(undefined), "fallback")).toBeNull();
    expect(
      cloudSandboxFailureMessage(
        AsyncResult.failure(
          Cause.fail({ _tag: "CloudSandboxProfileError", detail: "Key rejected" }),
        ),
        "fallback",
      ),
    ).toBe("Key rejected");
    expect(
      cloudSandboxFailureMessage(AsyncResult.failure(Cause.fail(new Error("Offline"))), "fallback"),
    ).toBe("Offline");
  });
});
